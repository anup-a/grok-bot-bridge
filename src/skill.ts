import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir } from "./config.js";

export const CLAUDE_SKILL = `---
name: grok-bots
description: Talk to the user's Grok Bot bots (for example Health, Growth, Investing, Chief of Staff) from here. Ask a bot a question and get its answer, send it a message, or run agent work on its behalf. Use when the user says "ask my <X> bot", "tell <X> ...", "check with <X>", or when a task needs information one of their Grok Bots has.
---

# Talking to Grok Bots with gbb

The \`gbb\` CLI (grok-bot-bridge) reaches any of the user's Grok Bots through their hub Bot (usually one named "Bridge").

- Ask and wait for the answer (usually 30 to 90 seconds; use a Bash timeout of at least 300000 ms):
  \`gbb ask <Bot> "<question>" --wait 240\`
  The answer is printed on stdout. Exit code 2 means no answer yet; check later with \`gbb inbox <message_id>\`.
- Send a message without waiting: \`gbb tell <Bot> "<message>"\`
- Recent questions and answers: \`gbb inbox\`
- Not sure which Bots exist? \`gbb ask Bridge "List my Bots and what each one does"\`

Write self-contained questions: the Bot can't see this conversation. Include the context it needs and say what form the answer should take.

Never ask a Bot to post, email, DM, publish or spend on the user's behalf unless the user explicitly asked for that.
`;

export function installClaudeSkill(): string {
  const dir = ensureDir(path.join(os.homedir(), ".claude", "skills", "grok-bots"), 0o755);
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, CLAUDE_SKILL);
  return `Installed Claude Code skill: ${file}`;
}
