# WATSNEX Follow-Up Agent

Watches the WATSNEX Google Calendar and keeps the Airtable **Lead Tracking → Follow -Up Status**
table (one row per person) up to date. It only *adds* people. It never edits or deletes rows you
filled in by hand.

## What it does

Every few minutes:

1. Pulls calendar events created or changed since the last check.
2. Keeps only **business** events: the title must contain "WATSNEX" or a meeting keyword
   (podcast, introduction, intro call, discovery, growth plan, follow up, "Pascal Cote and …").
   Anything with "buffer" in the title is always skipped, and so are personal events, holidays and
   appointments that don't match. (Change with `CALENDAR_TITLE_KEYWORDS` / `CALENDAR_TITLE_EXCLUDE`.
   Set `CALENDAR_TITLE_KEYWORDS=WATSNEX` to only accept titles containing WATSNEX.)
3. Asks Claude who the outside person is. Handles any title format: "Pre-Podcast Chat - Jennifer
   Wells", "Arra G. Yerganian and WATSNEX BioPharma", "podcast Jeff Whitmore (United Bio Channels) -
   Pascal (WATSNEX podcast)". It also uses the attendee list and description. Internal meetings like
   "WATSNEX Sync" are skipped, and you (Pascal) are never treated as the client.
4. **Duplicate check** against Follow -Up Status. That table has no email column, so the agent also
   reads **Dashboard CRM** (read only) to learn each person's emails and past meeting titles:
   - attendee email belongs to exactly one known person → already exists, nothing created;
   - otherwise similar names are short-listed (tolerates typos like "Joshn Mann"/"Micheal",
     nicknames, middle initials like "Arra G", accents, credentials) and Claude decides whether one
     is the same person, using their past meetings and emails as evidence.
5. **New person → creates a Follow -Up Status row** with the Name, and a Note saying which meeting
   it came from (plus company and email when known).
6. **Not sure?** (only a first name, no name at all, or *might* be someone already in the table) →
   the row is **still created**, marked "⚠️ Needs review" in its Note, and a **Slack message** is
   sent with a direct link to the row so you can fix the name in Airtable.

Each event is handled once. The row's Note is tagged with the Google event ID (`[gcal:…]`), so even
after a restart the same event never creates a second row.

## Setup

You need Node.js 20.12 or newer.

```bash
npm install
cp .env.example .env   # then fill in the values below
```

**1. Anthropic API key** — [console.anthropic.com](https://console.anthropic.com) → Settings → API
Keys → Create Key → `ANTHROPIC_API_KEY`.

**2. Google Calendar access (service account)**

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create a project (e.g. "WATSNEX agent").
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **IAM & Admin → Service Accounts → Create service account** (no roles needed).
4. Open it → **Keys → Add key → Create new key → JSON**. A `.json` file downloads.
5. Copy the service account's email (`…@….iam.gserviceaccount.com`).
6. In [Google Calendar](https://calendar.google.com) → ⚙️ **Settings** → your calendar →
   **Share with specific people** → add that email with **See all event details**.
7. Put the whole contents of the JSON file into `GOOGLE_SERVICE_ACCOUNT_JSON` (one line).

A service account doesn't expire, unlike a personal Google login token, so the agent keeps working
without you re-authorizing it.

**3. Airtable token** — [airtable.com/create/tokens](https://airtable.com/create/tokens) → **Create
token** → scopes `data.records:read` and `data.records:write` → access: **Lead Tracking** base →
`AIRTABLE_API_KEY`.

**4. Slack webhook** — [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From
scratch** → **Incoming Webhooks** → turn on → **Add New Webhook to Workspace** → pick the channel →
`SLACK_WEBHOOK_URL`.

## Running it

```bash
npm run dry-run                                   # one pass, shows what it WOULD do, writes nothing
npm run once -- --dry-run --since=2026-10-01T00:00:00Z   # same, looking back to a date
npm run once                                      # one real pass, then exit
npm start                                         # runs forever, one pass every 5 minutes
```

**Hosting (e.g. Railway):** create a new service from this repository, add the variables from
`.env.example` under **Variables**, and use `npm start` as the start command. It runs as a
background worker; no web domain is needed.

The output lists each business event and what happened to it (`created`, `created_needs_review`,
`already_exists`, `not_a_client_meeting`, or `error`). Events that errored are retried on the next
pass.

## Code

```
src/
  index.ts      Entry point: the polling loop and command-line flags
  run.ts        Main flow: fetch events → filter → identify person → dedupe → create → Slack
  google.ts     Google Calendar via service account
  airtable.ts   Reads Follow -Up Status + Dashboard CRM, creates rows
  match.ts      Fuzzy name/email short-listing of possible duplicates
  extract.ts    Claude prompt + structured output (who is the client, is it a duplicate)
  slack.ts      Slack webhook
  state.ts      Remembers what's been handled (data/state.json)
  config.ts     All settings and Airtable column names
```
