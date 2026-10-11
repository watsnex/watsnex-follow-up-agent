import { PEOPLE_FIELDS, MEETING_FIELDS, type AgentConfig } from "./config";
import { namesSimilar, normalizeTokens } from "./match";

/** A row of the people table (Follow-Up Status), enriched with what the meetings table knows about them. */
export interface Person {
  id: string;
  name: string;
  note: string;
  emails: string[];
  pastMeetings: string[];
}

const API = "https://api.airtable.com/v0";

async function airtableFetch(cfg: AgentConfig, tableId: string, path: string, init?: RequestInit) {
  const res = await fetch(`${API}/${cfg.airtableBaseId}/${encodeURIComponent(tableId)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.airtableToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) throw new Error(`Airtable request failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function listAll(cfg: AgentConfig, tableId: string, fields: string[]) {
  const rows: { id: string; fields: Record<string, unknown> }[] = [];
  let offset: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: "100" });
    for (const f of fields) params.append("fields[]", f);
    if (offset) params.set("offset", offset);
    const json = (await airtableFetch(cfg, tableId, `?${params}`)) as {
      records: { id: string; fields: Record<string, unknown> }[];
      offset?: string;
    };
    rows.push(...json.records);
    offset = json.offset;
  } while (offset);
  return rows;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Everyone in the people table, each with the emails and meeting titles the meetings table has
 * on record for a similar name (so "Josh Mann" picks up josh@lifesciencepro.com even though the
 * people table has no email column, and "Joshn Mann" typos still line up).
 */
export async function loadPeople(cfg: AgentConfig): Promise<Person[]> {
  const [peopleRows, meetingRows] = await Promise.all([
    listAll(cfg, cfg.peopleTableId, [PEOPLE_FIELDS.name, PEOPLE_FIELDS.note]),
    listAll(cfg, cfg.meetingsTableId, [MEETING_FIELDS.leadName, MEETING_FIELDS.email, MEETING_FIELDS.meetingName]),
  ]);

  const meetings = meetingRows.map((r) => ({
    leadName: str(r.fields[MEETING_FIELDS.leadName]),
    email: str(r.fields[MEETING_FIELDS.email]).toLowerCase(),
    meetingName: str(r.fields[MEETING_FIELDS.meetingName]),
  }));

  const people: Person[] = peopleRows.map((r) => ({
    id: r.id,
    name: str(r.fields[PEOPLE_FIELDS.name]),
    note: str(r.fields[PEOPLE_FIELDS.note]),
    emails: [],
    pastMeetings: [],
  }));

  // Attach each meeting to the person it most likely belongs to: an exact name match first,
  // otherwise the similar person with the most complete name — so a "David Esposito" meeting
  // goes to "David Esposito", not to a first-name-only "David" row.
  for (const m of meetings) {
    if (!m.leadName) continue;
    const similar = people.filter((p) => p.name && namesSimilar(p.name, m.leadName));
    if (similar.length === 0) continue;
    const exact = similar.filter((p) => tokenKey(p.name) === tokenKey(m.leadName));
    const best = exact.length > 0 ? exact : mostComplete(similar);
    for (const p of best) {
      if (m.email && !cfg.ignoredEmails.includes(m.email) && !p.emails.includes(m.email)) p.emails.push(m.email);
      if (m.meetingName && !p.pastMeetings.includes(m.meetingName) && p.pastMeetings.length < 4) {
        p.pastMeetings.push(m.meetingName);
      }
    }
  }
  return people;
}

function tokenKey(name: string): string {
  return normalizeTokens(name).join(" ");
}

function mostComplete(people: Person[]): Person[] {
  const max = Math.max(...people.map((p) => normalizeTokens(p.name).length));
  return people.filter((p) => normalizeTokens(p.name).length === max);
}

export async function createPerson(cfg: AgentConfig, fields: Record<string, string>): Promise<string> {
  const json = (await airtableFetch(cfg, cfg.peopleTableId, "", {
    method: "POST",
    body: JSON.stringify({ records: [{ fields }] }),
  })) as { records: { id: string }[] };
  return json.records[0].id;
}

export function recordUrl(cfg: AgentConfig, recordId: string): string {
  return `https://airtable.com/${cfg.airtableBaseId}/${cfg.peopleTableId}/${recordId}`;
}
