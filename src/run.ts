import { getAgentConfig, PEOPLE_FIELDS, type AgentConfig } from "./config";
import { listChangedEvents, type CalendarEvent } from "./google";
import { loadPeople, createPerson, updatePerson, recordUrl, type Person } from "./airtable";
import { findCandidates } from "./match";
import { analyzeEvent } from "./extract";
import { decideMeetingType, type CrmMeeting, type MeetingTypeResult } from "./meetingType";
import { notifySlack } from "./slack";
import { loadState, saveState, type Outcome } from "./state";

export interface EventResult {
  eventId: string;
  title: string;
  start: string;
  outcome: Outcome | "error";
  clientName?: string | null;
  recordId?: string;
  detail: string;
}

export interface RunSummary {
  dryRun: boolean;
  window: { updatedSince: string; until: string };
  scanned: number;
  businessEvents: number;
  results: EventResult[];
}

// Overlap each window slightly so events edited right at a run boundary aren't missed.
const OVERLAP_MS = 2 * 60 * 1000;

let running: Promise<RunSummary> | null = null;

/** Runs one sync pass. Concurrent calls share the same in-flight run instead of racing. */
export function runAgent(opts: { dryRun?: boolean; since?: Date } = {}): Promise<RunSummary> {
  if (!running) {
    running = syncOnce(opts).finally(() => {
      running = null;
    });
  }
  return running;
}

function eventKey(e: CalendarEvent): string {
  // Edited occurrences of a recurring series share the series' identity.
  return e.recurringEventId ?? e.id;
}

function agentRef(key: string): string {
  return `gcal:${key}`;
}

/** Rows created before the Agent Ref column existed carry the reference in their Note instead. */
function createdFromEvent(p: Person, key: string): boolean {
  return p.agentRef === agentRef(key) || p.note.includes(`[${agentRef(key)}]`);
}

/** "2026-10-13", the meeting's day in Montreal time, for Airtable date columns. */
function isoDate(start: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return start; // all-day event
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
}

/** "13 Oct 2026", in Montreal time. */
function friendlyDate(start: string): string {
  if (!start) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) start = `${start}T12:00:00Z`; // all-day event
  const d = new Date(start);
  if (Number.isNaN(d.getTime())) return start;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Toronto" });
}

function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isBusinessTitle(cfg: AgentConfig, title: string): boolean {
  const t = title.toLowerCase();
  if (cfg.titleExclude.some((k) => t.includes(k.toLowerCase()))) return false;
  return cfg.titleKeywords.some((k) => t.includes(k.toLowerCase()));
}

async function syncOnce(opts: { dryRun?: boolean; since?: Date }): Promise<RunSummary> {
  const cfg = getAgentConfig();
  const dryRun = Boolean(opts.dryRun);
  const state = loadState();
  const now = new Date();

  const updatedSince =
    opts.since ??
    (state.lastRunAt
      ? new Date(Date.parse(state.lastRunAt) - OVERLAP_MS)
      : new Date(now.getTime() - cfg.initialLookbackHours * 60 * 60 * 1000));

  const events = await listChangedEvents({
    serviceAccountJson: cfg.googleServiceAccountJson,
    calendarId: cfg.calendarId,
    updatedMin: updatedSince,
    // Only care about meetings that haven't already happened (plus a day of grace), unless backfilling.
    timeMin: new Date(Math.min(updatedSince.getTime(), now.getTime() - 24 * 60 * 60 * 1000)),
  });

  const relevant = events.filter((e) => isBusinessTitle(cfg, e.summary ?? ""));

  const summary: RunSummary = {
    dryRun,
    window: { updatedSince: updatedSince.toISOString(), until: now.toISOString() },
    scanned: events.length,
    businessEvents: relevant.length,
    results: [],
  };
  if (relevant.length === 0) {
    if (!dryRun) saveState({ ...state, lastRunAt: now.toISOString() });
    return summary;
  }

  // Loaded once per run; people created during this run are appended so two events for the
  // same new person in one batch don't create two records.
  const { people, crmMeetings } = await loadPeople(cfg);

  for (const event of relevant) {
    const key = eventKey(event);
    const title = event.summary ?? "";
    const start = event.start?.dateTime ?? event.start?.date ?? "";
    const previous = state.handled[key];
    // Dry runs and backfills (--since) look at every event again; creating is still duplicate-checked.
    const recheck = dryRun || Boolean(opts.since);
    let rescheduledPerson: Person | undefined;
    if (!recheck && previous) {
      const sameTitle = previous.title === title;
      // Nothing changed that matters (or it's a non-client event whose title didn't change).
      if (sameTitle && (previous.start === start || !previous.recordId)) continue;
      // Only the time moved → move the booking date; no need to ask Claude again.
      if (sameTitle) {
        rescheduledPerson = people.find((p) => p.id === previous.recordId);
        if (!rescheduledPerson) continue;
      }
    }

    try {
      const result = rescheduledPerson
        ? await handleReschedule(cfg, event, key, rescheduledPerson, crmMeetings, dryRun)
        : await handleEvent(cfg, event, key, people, crmMeetings, dryRun);
      summary.results.push(result);
      if (!dryRun && result.outcome !== "error") {
        state.handled[key] = {
          title,
          start,
          outcome: result.outcome as Outcome,
          at: now.toISOString(),
          recordId: result.recordId,
        };
      }
    } catch (err) {
      console.error(`[agent] Failed on event ${key} (${title}):`, err);
      summary.results.push({
        eventId: key,
        title,
        start,
        outcome: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!dryRun) {
    // If anything errored, keep the old window start so the next run retries those events.
    const hadErrors = summary.results.some((r) => r.outcome === "error");
    saveState({ ...state, lastRunAt: hadErrors ? state.lastRunAt : now.toISOString() });
  }
  return summary;
}

async function handleEvent(
  cfg: AgentConfig,
  event: CalendarEvent,
  key: string,
  people: Person[],
  crmMeetings: CrmMeeting[],
  dryRun: boolean,
): Promise<EventResult> {
  const title = event.summary ?? "";
  const start = event.start?.dateTime ?? event.start?.date ?? "";
  const base = { eventId: key, title, start };

  // 1. This exact calendar event already produced a record (e.g. state file was lost).
  const tagged = people.find((p) => createdFromEvent(p, key));
  if (tagged) {
    const meeting = decideMeetingType(crmMeetings, { title, start, emails: [], guess: null });
    const booking = await applyBooking(cfg, tagged, { title, start, meeting }, dryRun);
    return { ...base, outcome: "already_exists", clientName: tagged.name, recordId: tagged.id, detail: `Record already created from this event; ${booking}` };
  }

  const attendees = (event.attendees ?? []).filter(
    (a) => !a.self && !a.resource && !(a.email && cfg.ignoredEmails.includes(a.email.toLowerCase())),
  );
  const attendeeEmails = attendees.map((a) => a.email?.toLowerCase()).filter((e): e is string => Boolean(e));
  const description = stripHtml(event.description ?? "").slice(0, 4000);

  const candidates = findCandidates(
    people,
    { texts: [title, ...attendees.map((a) => a.displayName ?? "")], emails: attendeeEmails },
    cfg.ownerName,
  );

  // 2. Ask Claude who the client is and whether any candidate is the same person.
  const analysis = await analyzeEvent({
    ownerName: cfg.ownerName,
    title,
    start,
    attendees,
    description,
    candidates,
  });

  if (!analysis.isClientMeeting) {
    return { ...base, outcome: "not_a_client_meeting", detail: analysis.reason };
  }

  // Meeting type: Dashboard CRM, then the title, then Claude's guess (flagged for a human to check).
  const meeting = decideMeetingType(crmMeetings, {
    title,
    start,
    emails: attendeeEmails,
    guess: analysis.meetingType === "Unknown" ? null : analysis.meetingType,
  });

  // 3. Duplicate check. An email that belongs to exactly one known person always wins,
  //    regardless of how the name is spelled.
  const clientEmail =
    analysis.clientEmail?.toLowerCase() ?? (attendeeEmails.length === 1 ? attendeeEmails[0] : null);
  const emailOwners = clientEmail ? people.filter((p) => p.emails.includes(clientEmail)) : [];
  if (emailOwners.length === 1) {
    const p = emailOwners[0];
    const booking = await applyBooking(cfg, p, { title, start, meeting }, dryRun);
    return { ...base, outcome: "already_exists", clientName: p.name, recordId: p.id, detail: `Same email as existing person "${p.name}"; ${booking}` };
  }

  const nameMatch = candidates.find((c) => c.id === analysis.matchedRecordId);
  if (nameMatch && analysis.matchConfidence === "certain") {
    const booking = await applyBooking(cfg, nameMatch, { title, start, meeting }, dryRun);
    return { ...base, outcome: "already_exists", clientName: nameMatch.name, recordId: nameMatch.id, detail: `Matches existing person "${nameMatch.name}"; ${booking}` };
  }

  // 4. New person → create the record. Flag it for review when the agent isn't sure.
  const reviewReasons: string[] = [];
  if (!analysis.clientName) reviewReasons.push("Couldn't work out the client's name from the event");
  else if (analysis.nameConfidence === "low") reviewReasons.push(analysis.nameConcern || "Name may be incomplete");
  if (nameMatch && analysis.matchConfidence === "possible") {
    reviewReasons.push(`Might be the same person as "${nameMatch.name}" (${recordUrl(cfg, nameMatch.id)})`);
  }
  const name = analysis.clientName || clientEmail || `Unknown – ${title}`;

  // Meeting type is always filled in; a guess (or no answer) is flagged so someone checks it.
  if (meeting.source === "guess") {
    reviewReasons.push(`Meeting type is a guess ("${meeting.type}"); please check "${PEOPLE_FIELDS.meetingType}"`);
  } else if (meeting.source === "none") {
    reviewReasons.push(`Couldn't tell the meeting type; please set "${PEOPLE_FIELDS.meetingType}"`);
  }
  const needsReview = reviewReasons.length > 0;
  const date = friendlyDate(start);

  const note = [
    `From calendar: ${meeting.type ?? "Meeting"}${date ? ` on ${date}` : ""} ("${title}")`,
    ...(analysis.company ? [`Company: ${analysis.company}`] : []),
    ...(clientEmail ? [`Email: ${clientEmail}`] : []),
    ...(needsReview ? [`⚠️ Needs review: ${reviewReasons.join("; ")}`] : []),
  ].join("\n");

  const outcome: Outcome = needsReview ? "created_needs_review" : "created";
  const typeLabel = `${meeting.type ?? "type unknown"} (from ${meeting.source})`;
  if (dryRun) {
    return {
      ...base,
      outcome,
      clientName: name,
      detail: `[dry run] Would create "${name}" — ${typeLabel}${needsReview ? ` (review: ${reviewReasons.join("; ")})` : ""}`,
    };
  }

  const fields: Record<string, string> = {
    [PEOPLE_FIELDS.name]: name,
    [PEOPLE_FIELDS.note]: note,
    [PEOPLE_FIELDS.agentRef]: agentRef(key),
  };
  if (meeting.type) fields[PEOPLE_FIELDS.meetingType] = meeting.type;
  const bookingDay = upcomingDay(start);
  if (bookingDay && !isCanceled(title)) fields[PEOPLE_FIELDS.nextBooking] = bookingDay;
  const recordId = await createPerson(cfg, fields);
  people.push({
    id: recordId,
    name,
    note,
    agentRef: agentRef(key),
    nextBooking: fields[PEOPLE_FIELDS.nextBooking] ?? "",
    meetingType: meeting.type ?? "",
    emails: clientEmail ? [clientEmail] : [],
    pastMeetings: [title],
  });

  if (needsReview) {
    await notifySlack(
      cfg.slackWebhookUrl,
      [
        `:warning: *New follow-up record needs a check*`,
        `*Saved as:* ${name}${analysis.company ? ` (${analysis.company})` : ""}`,
        `*Meeting:* ${title}`,
        `*When:* ${date || start}`,
        `*Suggested meeting type:* ${meeting.type ?? "not sure"}${meeting.source === "guess" ? " (a guess)" : ""}`,
        `*Why:* ${reviewReasons.join("; ")}`,
        `Please confirm or fix it here: ${recordUrl(cfg, recordId)}`,
      ].join("\n"),
    );
  }

  return {
    ...base,
    outcome,
    clientName: name,
    recordId,
    detail: `Created — ${typeLabel}${needsReview ? `; sent to Slack for review (${reviewReasons.join("; ")})` : ""}`,
  };
}

function isCanceled(title: string): boolean {
  return /^cancel+ed:/i.test(title.trim());
}

/** The meeting's day ("YYYY-MM-DD") if it's today or later, otherwise null. */
function upcomingDay(start: string): string | null {
  const day = isoDate(start);
  const today = isoDate(new Date().toISOString());
  return day && today && day >= today ? day : null;
}

/**
 * An existing lead has a booking: set Next Booking and Suggested Meeting Type to it, unless they
 * already have an earlier upcoming booking (that one stays "next"). Past and canceled meetings
 * don't change anything. Returns a short description of what happened, for the log.
 */
async function applyBooking(
  cfg: AgentConfig,
  person: Person,
  booking: { title: string; start: string; meeting: MeetingTypeResult },
  dryRun: boolean,
): Promise<string> {
  if (isCanceled(booking.title)) return "canceled booking, nothing updated";
  const day = upcomingDay(booking.start);
  if (!day) return "meeting already past, booking not updated";
  const today = isoDate(new Date().toISOString())!;
  if (person.nextBooking && person.nextBooking >= today && person.nextBooking < day) {
    return `keeps earlier upcoming booking (${person.nextBooking})`;
  }

  const fields: Record<string, string> = {};
  if (person.nextBooking !== day) fields[PEOPLE_FIELDS.nextBooking] = day;
  if (booking.meeting.type && person.meetingType !== booking.meeting.type) {
    fields[PEOPLE_FIELDS.meetingType] = booking.meeting.type;
  }
  if (Object.keys(fields).length === 0) return "booking already up to date";

  const change = [
    ...(fields[PEOPLE_FIELDS.nextBooking] ? [`Next Booking ${person.nextBooking || "(empty)"} → ${day}`] : []),
    ...(fields[PEOPLE_FIELDS.meetingType]
      ? [`type ${person.meetingType || "(empty)"} → ${booking.meeting.type} (from ${booking.meeting.source})`]
      : []),
  ].join(", ");
  if (dryRun) return `[dry run] would update ${change}`;

  await updatePerson(cfg, person.id, fields);
  if (fields[PEOPLE_FIELDS.nextBooking]) person.nextBooking = day;
  if (fields[PEOPLE_FIELDS.meetingType]) person.meetingType = fields[PEOPLE_FIELDS.meetingType];

  if (booking.meeting.source === "guess" || booking.meeting.source === "none") {
    await notifySlack(
      cfg.slackWebhookUrl,
      [
        `:calendar: *Existing lead booked again: please check the meeting type*`,
        `*Lead:* ${person.name}`,
        `*Meeting:* ${booking.title}`,
        `*When:* ${friendlyDate(booking.start)}`,
        `*Suggested meeting type:* ${booking.meeting.type ? `${booking.meeting.type} (a guess)` : "not sure"}`,
        `Please confirm or fix it here: ${recordUrl(cfg, person.id)}`,
      ].join("\n"),
    );
  }
  return `updated ${change}`;
}

/** The event that created or matched this person only moved in time: update the booking, no Claude call. */
async function handleReschedule(
  cfg: AgentConfig,
  event: CalendarEvent,
  key: string,
  person: Person,
  crmMeetings: CrmMeeting[],
  dryRun: boolean,
): Promise<EventResult> {
  const title = event.summary ?? "";
  const start = event.start?.dateTime ?? event.start?.date ?? "";
  const meeting = decideMeetingType(crmMeetings, { title, start, emails: person.emails, guess: null });
  const booking = await applyBooking(cfg, person, { title, start, meeting: meeting.type ? meeting : { type: null, source: "title" } }, dryRun);
  return { eventId: key, title, start, outcome: "already_exists", clientName: person.name, recordId: person.id, detail: `Rescheduled; ${booking}` };
}
