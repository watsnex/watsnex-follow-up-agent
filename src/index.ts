import fs from "fs";
import { runAgent, type RunSummary } from "./run";

// Usage:
//   npm start                      → runs forever, one pass every POLL_INTERVAL_MINUTES (default 5)
//   npm run once                   → one pass, then exit (for cron schedulers)
//   npm run once -- --dry-run      → one pass that only reports what it would do
//   npm run once -- --since=2026-10-01T00:00:00Z   → re-scan events changed since a date (backfill)

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const args = process.argv.slice(2);
const once = args.includes("--once");
const dryRun = args.includes("--dry-run");
const sinceArg = args.find((a) => a.startsWith("--since="))?.slice("--since=".length);
const since = sinceArg ? new Date(sinceArg) : undefined;
if (since && Number.isNaN(since.getTime())) {
  console.error(`Invalid --since date: ${sinceArg}`);
  process.exit(1);
}

function report(summary: RunSummary) {
  const stamp = new Date().toISOString();
  console.log(
    `[${stamp}] ${summary.dryRun ? "(dry run) " : ""}scanned ${summary.scanned} changed events, ${summary.businessEvents} business, ${summary.results.length} handled`,
  );
  for (const r of summary.results) {
    console.log(`  - ${r.outcome.padEnd(22)} ${r.title}${r.clientName ? ` → ${r.clientName}` : ""} — ${r.detail}`);
  }
}

async function pass(): Promise<boolean> {
  try {
    const summary = await runAgent({ dryRun, since });
    report(summary);
    return !summary.results.some((r) => r.outcome === "error");
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Run failed:`, err instanceof Error ? err.message : err);
    return false;
  }
}

if (once || dryRun) {
  const ok = await pass();
  process.exit(ok ? 0 : 1);
} else {
  const minutes = Number(process.env.POLL_INTERVAL_MINUTES || 5);
  console.log(`WATSNEX Follow-Up Agent started — checking the calendar every ${minutes} min.`);
  await pass();
  setInterval(pass, minutes * 60 * 1000);
}
