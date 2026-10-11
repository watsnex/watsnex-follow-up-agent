import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not set. See README → Setup.");
    }
    client = new Anthropic();
  }
  return client;
}

export const MODEL = "claude-opus-5-5";
