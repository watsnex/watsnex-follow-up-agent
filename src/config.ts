// All knobs for the calendar → Airtable agent live here, read from env with sensible defaults.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. See README → "Setup".`);
  return value;
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getAgentConfig() {
  return {
    googleServiceAccountJson: required("GOOGLE_SERVICE_ACCOUNT_JSON"),
    calendarId: process.env.GOOGLE_CALENDAR_ID || "pc.watsnex@gmail.com",

    airtableToken: required("AIRTABLE_API_KEY"),
    airtableBaseId: process.env.AIRTABLE_BASE_ID || "appp0YgbXPa9M2OyB", // Lead Tracking
    // One row per person — where new clients get added.
    peopleTableId: process.env.AIRTABLE_PEOPLE_TABLE_ID || "tblj1lVaR4W1bYHxx", // Follow -Up Status
    // One row per meeting — read only, used to recognise people by email / past meetings.
    meetingsTableId: process.env.AIRTABLE_MEETINGS_TABLE_ID || "tblDVG3PHN9j7GdLO", // Dashboard CRM

    // Optional — without it, review alerts are only logged.
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || null,

    // Only events whose title contains one of these (case-insensitive) are looked at…
    titleKeywords: list("CALENDAR_TITLE_KEYWORDS", [
      "WATSNEX",
      "podcast",
      "introduction",
      "intro call",
      "discovery",
      "growth plan",
      "follow up",
      "follow-up",
      "followup",
      "Pascal Cote",
      "Pascal Côté",
    ]),
    // …and never events whose title contains one of these.
    titleExclude: list("CALENDAR_TITLE_EXCLUDE", ["buffer"]),
    // The calendar owner — never treated as the client.
    ownerName: process.env.CALENDAR_OWNER_NAME || "Pascal Côté",
    // Attendee emails that are never the client (you, note-takers, teammates).
    ignoredEmails: list("CALENDAR_IGNORED_EMAILS", ["pc.watsnex@gmail.com", "fred@fireflies.ai"]).map(
      (e) => e.toLowerCase(),
    ),
    // How far back to look on the very first run (or if state was lost), in hours.
    initialLookbackHours: Number(process.env.CALENDAR_INITIAL_LOOKBACK_HOURS || 24),
  };
}

export type AgentConfig = ReturnType<typeof getAgentConfig>;

// Column names in Airtable. Change here if the tables' columns are renamed.
export const PEOPLE_FIELDS = {
  name: "Name",
  note: "Note",
} as const;

export const MEETING_FIELDS = {
  leadName: "Lead Name",
  email: "Email",
  meetingName: "Meeting Name",
} as const;
