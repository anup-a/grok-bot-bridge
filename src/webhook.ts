import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir, getCredentials, homeDir, loadConfig, readJson, withLock, writeJsonAtomic } from "./config.js";

export const VERSION = "0.1.0";

export type EventName = "ping" | "note" | "ask" | "job_done" | "job_failed" | string;

export interface Payload {
  source: "grok-bot-bridge";
  version: string;
  event: EventName;
  host: string;
  ts: string;
  summary: string;
  /** Human-readable rendering, for routines that paste the body into a prompt. */
  text: string;
  agent?: string;
  /** Target Bot when the receiving Bot acts as a hub. */
  to?: string;
  message_id?: string;
  reply_to?: string;
  job_id?: string;
  session_id?: string;
  cwd?: string;
  files?: string[];
  /** Ready-to-run follow-up commands for the bot. */
  next?: string[];
  [k: string]: unknown;
}

export interface SendResult {
  ok: boolean;
  status?: number;
  body?: string;
  skipped?: string;
}

export function buildPayload(
  event: EventName,
  summary: string,
  extra: Partial<Omit<Payload, "source" | "version" | "event" | "summary" | "text">> = {},
  maxChars = loadConfig().maxSummaryChars,
): Payload {
  let s = summary.trim();
  if (s.length > maxChars) {
    // Keep the start and (mostly) the end: agents usually put the final answer last.
    const head = Math.floor(maxChars / 3);
    const tailLen = maxChars - head;
    s = `${s.slice(0, head)}\n...[${s.length - maxChars} chars omitted]...\n${s.slice(-tailLen)}`;
  }
  const base = {
    source: "grok-bot-bridge" as const,
    version: VERSION,
    event,
    host: os.hostname(),
    ts: new Date().toISOString(),
    summary: s,
  };
  const clean = Object.fromEntries(
    Object.entries(extra).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)),
  );
  const head = `[grok-bot-bridge] ${event}${extra.to ? ` for ${extra.to}` : ""}${extra.agent ? ` from ${extra.agent}` : ""}${extra.job_id ? ` (job ${extra.job_id})` : ""}`;
  const lines = [head, "", s];
  if (Array.isArray(clean.files) && clean.files.length) lines.push("", "Files:", ...clean.files.map((f) => `- ${f}`));
  if (Array.isArray(clean.next) && clean.next.length) lines.push("", "Next:", ...clean.next.map((c) => `- ${c}`));
  return { ...base, ...clean, text: lines.join("\n") } as Payload;
}

const stateFile = () => path.join(homeDir(), "state.json");
export const logFile = () => path.join(homeDir(), "notify.log");

export function log(msg: string): void {
  ensureDir(homeDir());
  fs.appendFileSync(logFile(), `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
}

interface SendState {
  sent?: Record<string, number[]>;
}

function takeRateSlot(bot: string, maxPerHour: number): boolean {
  return withLock("state", () => takeRateSlotUnlocked(bot, maxPerHour));
}

function takeRateSlotUnlocked(bot: string, maxPerHour: number): boolean {
  ensureDir(homeDir());
  const state = readJson<SendState & Record<string, unknown>>(stateFile(), {});
  const now = Date.now();
  const sent = (state.sent?.[bot] ?? []).filter((t) => now - t < 3600_000);
  if (sent.length >= maxPerHour) return false;
  sent.push(now);
  state.sent = { ...(state.sent ?? {}), [bot]: sent };
  writeJsonAtomic(stateFile(), state);
  return true;
}

export async function send(payload: Payload, opts: { bot?: string; force?: boolean } = {}): Promise<SendResult> {
  const cfg = loadConfig();
  const bot = opts.bot ?? cfg.defaultBot;
  if (process.env.GBB_SILENT === "1" && !opts.force) {
    log(`skip: GBB_SILENT bot=${bot} event=${payload.event}`);
    return { ok: false, skipped: "GBB_SILENT=1" };
  }
  const creds = getCredentials(bot, cfg);
  if (!creds) {
    log(`skip: no credentials for bot=${bot} (run: gbb setup --bot ${bot})`);
    return { ok: false, skipped: `no credentials for bot "${bot}" (run: gbb setup --bot ${bot})` };
  }
  if (!takeRateSlot(bot, cfg.maxPerHour)) {
    log(`skip: rate limit ${cfg.maxPerHour}/h bot=${bot} event=${payload.event}`);
    return { ok: false, skipped: `rate limit (${cfg.maxPerHour}/hour)` };
  }
  try {
    const res = await fetch(creds.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.text()).slice(0, 500);
    log(`${res.ok ? "sent" : "failed"} ${res.status} bot=${bot} event=${payload.event} ${JSON.stringify(body.slice(0, 200))}`);
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    log(`error bot=${bot} event=${payload.event} ${(err as Error).message}`);
    return { ok: false, body: (err as Error).message };
  }
}
