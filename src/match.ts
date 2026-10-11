import type { Person } from "./airtable";

// Cheap, deterministic pre-filter: pick the handful of people who could plausibly be the person in
// this event (same email, same company domain, or a shared/near-identical name token), so Claude
// only has to judge a short list instead of the whole table.

const STOPWORDS = new Set([
  "and", "with", "the", "for", "call", "chat", "meeting", "intro", "introduction", "discovery",
  "follow", "followup", "up", "pre", "podcast", "recording", "part", "ii", "mins", "min", "minutes",
  "session", "prep", "scoping", "strategic", "growth", "plan", "presentation", "ai", "solutions",
  "watsnex", "biopharma", "pharma", "dr", "md", "phd", "pharmd", "mr", "mrs", "ms", "msj", "mba",
  "jr", "sr", "inc", "llc", "ltd", "test", "one", "on", "of", "et", "avec", "appel",
]);

const GENERIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
]);

export function normalizeTokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  // "Bhattachanya" vs "Bhattacharya", "Joshn" vs "Josh", "Micheal" vs "Michael": tolerate small
  // typos — one edit on short names, two on longer ones.
  const longest = Math.max(a.length, b.length);
  if (longest >= 7) return editDistance(a, b) <= 2;
  if (longest >= 4) return editDistance(a, b) <= 1;
  return false;
}

/** True when every name token of the shorter name has a (near-)match in the longer one. */
export function namesSimilar(a: string, b: string): boolean {
  const ta = normalizeTokens(a);
  const tb = normalizeTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return short.every((s) => long.some((l) => tokensMatch(s, l)));
}

export function emailDomain(email: string): string {
  return email.toLowerCase().split("@")[1] ?? "";
}

export function findCandidates(
  people: Person[],
  query: { texts: string[]; emails: string[] },
  ownerName: string,
  limit = 15,
): Person[] {
  const ownerTokens = new Set(normalizeTokens(ownerName));
  const queryTokens = new Set(
    [...query.texts, ...query.emails.map((e) => e.split("@")[0])]
      .flatMap(normalizeTokens)
      .filter((t) => !ownerTokens.has(t)),
  );
  const queryEmails = new Set(query.emails.map((e) => e.toLowerCase()));
  const queryDomains = new Set(
    [...queryEmails].map(emailDomain).filter((d) => d && !GENERIC_DOMAINS.has(d)),
  );

  const scored = people.map((p) => {
    let score = 0;
    for (const email of p.emails) {
      if (queryEmails.has(email)) score += 100;
      else if (queryDomains.has(emailDomain(email))) score += 5;
    }
    for (const pt of normalizeTokens(p.name)) {
      for (const qt of queryTokens) {
        if (tokensMatch(pt, qt)) score += pt.length >= 4 ? 3 : 1;
      }
    }
    return { p, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.p);
}
