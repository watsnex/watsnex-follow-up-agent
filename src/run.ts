import { getAgentConfig, PEOPLE_FIELDS, type AgentConfig } from "./config";
import { listChangedEvents, type CalendarEvent } from "./google";
import { loadPeople, createPerson, recordUrl, type Person } from "./airtable";
import { findCandidates } from "./match";
import { analyzeEvent } from "./extract";
import { decideMeetingType, type CrmMeeting } from "./meetingType";
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

    // Already handled and the title hasn't changed since → nothing new to learn.
    // (A dry run previews every event; it never writes, so re-checking is harmless.)
    if (!dryRun && previous && previous.title === title) continue;
    // Once a person record exists for this event, never create another one, even if the title changes.
    if (!dryRun && previous && previous.outcome !== "not_a_client_meeting") continue;

    try {
      const result = await handleEvent(cfg, event, key, people, crmMeetings, dryRun);
      summary.results.push(result);
      if (!dryRun && result.outcome !== "error") {
        state.handled[key] = {
          title,
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
    return { ...base, outcome: "already_exists", clientName: tagged.name, recordId: tagged.id, detail: "Record already created from this event" };
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

  // 3. Duplicate check. An email that belongs to exactly one known person always wins,
  //    regardless of how the name is spelled.
  const clientEmail =
    analysis.clientEmail?.toLowerCase() ?? (attendeeEmails.length === 1 ? attendeeEmails[0] : null);
  const emailOwners = clientEmail ? people.filter((p) => p.emails.includes(clientEmail)) : [];
  if (emailOwners.length === 1) {
    const p = emailOwners[0];
    return { ...base, outcome: "already_exists", clientName: p.name, recordId: p.id, detail: `Same email as existing person "${p.name}"` };
  }

  const nameMatch = candidates.find((c) => c.id === analysis.matchedRecordId);
  if (nameMatch && analysis.matchConfidence === "certain") {
    return { ...base, outcome: "already_exists", clientName: nameMatch.name, recordId: nameMatch.id, detail: `Matches existing person "${nameMatch.name}"` };
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
  const meeting = decideMeetingType(crmMeetings, {
    title,
    start,
    emails: clientEmail ? [clientEmail, ...attendeeEmails] : attendeeEmails,
    guess: analysis.meetingType === "Unknown" ? null : analysis.meetingType,
  });
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
  const recordId = await createPerson(cfg, fields);
  people.push({ id: recordId, name, note, agentRef: agentRef(key), emails: clientEmail ? [clientEmail] : [], pastMeetings: [title] });

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
