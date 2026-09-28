import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir, getCredentials, homeDir, loadConfig, readJson, withLock, writeJsonAtomic } from "./config.js";
export const VERSION = "0.2.0";
export function buildPayload(event, summary, extra = {}, maxChars = loadConfig().maxSummaryChars) {
    let s = summary.trim();
    if (s.length > maxChars) {
        // Keep the start and (mostly) the end: agents usually put the final answer last.
        const head = Math.floor(maxChars / 3);
        const tailLen = maxChars - head;
        s = `${s.slice(0, head)}\n...[${s.length - maxChars} chars omitted]...\n${s.slice(-tailLen)}`;
    }
    const base = {
        source: "grok-bot-bridge",
        version: VERSION,
        event,
        host: os.hostname(),
        ts: new Date().toISOString(),
        summary: s,
    };
    const clean = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0)));
    const head = `[grok-bot-bridge] ${event}${extra.to ? ` for ${extra.to}` : ""}${extra.agent ? ` from ${extra.agent}` : ""}${extra.job_id ? ` (job ${extra.job_id})` : ""}`;
    const lines = [head, "", s];
    if (Array.isArray(clean.files) && clean.files.length)
        lines.push("", "Files:", ...clean.files.map((f) => `- ${f}`));
    if (Array.isArray(clean.next) && clean.next.length)
        lines.push("", "Next:", ...clean.next.map((c) => `- ${c}`));
    return { ...base, ...clean, text: lines.join("\n") };
}
const stateFile = () => path.join(homeDir(), "state.json");
export const logFile = () => path.join(homeDir(), "notify.log");
export function log(msg) {
    ensureDir(homeDir());
    fs.appendFileSync(logFile(), `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
}
function takeRateSlot(bot, maxPerHour) {
    return withLock("state", () => takeRateSlotUnlocked(bot, maxPerHour));
}
function takeRateSlotUnlocked(bot, maxPerHour) {
    ensureDir(homeDir());
    const state = readJson(stateFile(), {});
    const now = Date.now();
    const sent = (state.sent?.[bot] ?? []).filter((t) => now - t < 3600_000);
    if (sent.length >= maxPerHour)
        return false;
    sent.push(now);
    state.sent = { ...(state.sent ?? {}), [bot]: sent };
    writeJsonAtomic(stateFile(), state);
    return true;
}
export async function send(payload, opts = {}) {
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
    }
    catch (err) {
        log(`error bot=${bot} event=${payload.event} ${err.message}`);
        return { ok: false, body: err.message };
    }
}
