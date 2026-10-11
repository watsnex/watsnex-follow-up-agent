/** Posts to a Slack incoming webhook. Returns false (and logs) if no webhook is configured. */
export async function notifySlack(webhookUrl: string | null, text: string): Promise<boolean> {
  if (!webhookUrl) {
    console.warn("[agent] SLACK_WEBHOOK_URL not set — would have sent:\n" + text);
    return false;
  }
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack webhook failed (${res.status}): ${await res.text()}`);
  return true;
}
