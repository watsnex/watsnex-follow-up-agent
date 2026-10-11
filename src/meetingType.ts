// Works out what kind of meeting a calendar event is. Options use the same names as
// Dashboard CRM's "Meeting Type" column, so both tables speak the same language.

export const MEETING_TYPES = [
  "Introduction Meeting",
  "Discovery Meeting",
  "Pre-Podcast Chat",
  "Podcast Meeting",
  "Follow Up Meeting",
  "Growth Plan Meeting",
] as const;

export type MeetingType = (typeof MEETING_TYPES)[number];

/** A row of Dashboard CRM, reduced to what's needed to recognise a meeting. */
export interface CrmMeeting {
  email: string;
  meetingName: string;
  start: string;
  meetingType: string;
}

export interface MeetingTypeResult {
  type: MeetingType | null;
  /** Where the answer came from; "guess" means a human should check it. */
  source: "dashboard_crm" | "title" | "guess" | "none";
}

const HOUR_MS = 60 * 60 * 1000;

function isMeetingType(value: string): value is MeetingType {
  return (MEETING_TYPES as readonly string[]).includes(value);
}

/** The Meeting Type Dashboard CRM already has for this exact meeting (same person, same start time). */
function fromDashboardCrm(
  crm: CrmMeeting[],
  input: { title: string; start: string; emails: string[] },
): MeetingType | null {
  const start = Date.parse(input.start);
  const title = input.title.trim().toLowerCase();
  const match = crm.find((m) => {
    if (!isMeetingType(m.meetingType)) return false;
    const sameTime = !Number.isNaN(start) && Math.abs(Date.parse(m.start) - start) < HOUR_MS;
    const samePerson = m.email !== "" && input.emails.includes(m.email);
    const sameTitle = m.meetingName.trim().toLowerCase() === title;
    return sameTime && (samePerson || sameTitle);
  });
  return match ? (match.meetingType as MeetingType) : null;
}

/** Keyword rules for the title formats in use. Order matters: "pre-podcast" before "podcast", etc. */
export function fromTitle(rawTitle: string): MeetingType | null {
  const title = rawTitle.replace(/^(canceled|cancelled|updated invitation):\s*/i, "").trim();
  const t = title.toLowerCase();
  if (/pre[-\s]?podcast/.test(t)) return "Pre-Podcast Chat";
  if (/podcast/.test(t)) return "Podcast Meeting";
  if (/follow[-\s]?up/.test(t)) return "Follow Up Meeting";
  if (/growth\s*plan/.test(t)) return "Growth Plan Meeting";
  if (/discovery/.test(t)) return "Discovery Meeting";
  if (/\bintro(duction)?\b/.test(t)) return "Introduction Meeting";
  // "Simon Wright and WATSNEX BioPharma" is the Calendly introduction booking title.
  if (/^.+\s+and\s+watsnex\s+biopharma$/i.test(title)) return "Introduction Meeting";
  return null;
}

/** Dashboard CRM first, then the title, then the model's guess (flagged for review). */
export function decideMeetingType(
  crm: CrmMeeting[],
  input: { title: string; start: string; emails: string[]; guess: string | null },
): MeetingTypeResult {
  const crmType = fromDashboardCrm(crm, input);
  if (crmType) return { type: crmType, source: "dashboard_crm" };
  const titleType = fromTitle(input.title);
  if (titleType) return { type: titleType, source: "title" };
  if (input.guess && isMeetingType(input.guess)) return { type: input.guess, source: "guess" };
  return { type: null, source: "none" };
}
