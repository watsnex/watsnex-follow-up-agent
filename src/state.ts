import fs from "fs";
import path from "path";

// Remembers when the agent last ran and which events it already handled, so each event is only
// sent to Claude once. Losing this file is safe: the Airtable duplicate check still prevents
// duplicate records, it just costs a few extra Claude calls.

export type Outcome = "created" | "created_needs_review" | "already_exists" | "not_a_client_meeting";

export interface AgentState {
  lastRunAt: string | null;
  handled: Record<string, { title: string; start?: string; outcome: Outcome; at: string; recordId?: string }>;
}

const STATE_PATH = path.join(process.cwd(), "data", "state.json");
const KEEP_DAYS = 90;

export function loadState(): AgentState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
    return { lastRunAt: parsed.lastRunAt ?? null, handled: parsed.handled ?? {} };
  } catch {
    return { lastRunAt: null, handled: {} };
  }
}

export function saveState(state: AgentState): void {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const [key, entry] of Object.entries(state.handled)) {
    if (Date.parse(entry.at) < cutoff) delete state.handled[key];
  }
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn("[agent] Could not persist state:", err);
  }
}
