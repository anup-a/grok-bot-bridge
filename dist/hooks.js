import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, expandHome, homeDir, loadConfig, readJson, writeJsonAtomic } from "./config.js";
import { buildPayload, log } from "./webhook.js";
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
const watchStateFile = () => path.join(homeDir(), "watch-state.json");
/**
 * Return text appended to each watched file since the last check, advancing the baseline.
 * The first time a file is seen it is only baselined (history is not replayed).
 */
export function collectAppended(files) {
    ensureDir(homeDir());
    const state = readJson(watchStateFile(), {});
    const out = [];
    for (const raw of files) {
        const file = path.resolve(expandHome(raw));
        let size;
        try {
            size = fs.statSync(file).size;
        }
        catch {
            continue;
        }
        const seen = state[file];
        state[file] = size;
        if (seen === undefined || size <= seen)
            continue;
        const fd = fs.openSync(file, "r");
        try {
            const buf = Buffer.alloc(size - seen);
            fs.readSync(fd, buf, 0, buf.length, seen);
            const text = buf.toString("utf8").trim();
            if (text)
                out.push({ file, text });
        }
        finally {
            fs.closeSync(fd);
        }
    }
    writeJsonAtomic(watchStateFile(), state);
    return out;
}
/** Queue a payload and send it from a detached process, so the agent's hook returns instantly. */
export function sendDetached(payload, bot) {
    const outbox = ensureDir(path.join(homeDir(), "outbox"));
    const file = path.join(outbox, `${Date.now()}-${crypto.randomBytes(3).toString("hex")}.json`);
    writeJsonAtomic(file, payload);
    const args = [CLI, "_send", file, ...(bot ? ["--bot", bot] : [])];
    spawn(process.execPath, args, { detached: true, stdio: "ignore" }).unref();
}
/**
 * Entry point for agent hooks.
 * - claude: Claude Code `Stop` hook, JSON on stdin.
 * - codex:  Codex `notify` program, JSON as the last argv.
 */
export function handleHook(source, input) {
    let data = {};
    try {
        data = JSON.parse(input || "{}");
    }
    catch {
        /* tolerate empty/invalid input */
    }
    if (source === "claude" && data.stop_hook_active)
        return;
    if (source === "codex" && data.type && data.type !== "agent-turn-complete")
        return;
    const cfg = loadConfig();
    const appended = collectAppended(cfg.watch);
    // Inside a `gbb run` job the worker reports the result itself; only advance the baseline.
    if (process.env.GBB_JOB_ID || process.env.GBB_SILENT === "1" || appended.length === 0)
        return;
    const cwd = String(data.cwd ?? process.cwd());
    const sessionId = String(data.session_id ?? data["thread-id"] ?? "");
    for (const { file, text } of appended) {
        sendDetached(buildPayload("handoff", text, { agent: source, cwd, session_id: sessionId || undefined, files: [file] }));
    }
    log(`hook ${source}: queued ${appended.length} handoff event(s)`);
}
// ---------- installers ----------
function hookCommand(source) {
    // Call the executable CLI (#!/usr/bin/env node) rather than pinning process.execPath,
    // which is often a versioned path (e.g. Homebrew Cellar) that breaks on upgrade.
    return [CLI, "hook", source];
}
function warnIfEphemeral() {
    return CLI.includes(`${path.sep}_npx${path.sep}`)
        ? "Warning: gbb is running from the npx cache, which can be cleaned up. Install globally first: npm i -g grok-bot-bridge"
        : undefined;
}
const claudeSettings = () => path.join(os.homedir(), ".claude", "settings.json");
const isOurs = (cmd) => {
    const plain = cmd.replaceAll('"', "");
    return /grok-bot-bridge|\bgbb\b/.test(plain) && / hook claude\b/.test(plain);
};
export function installClaudeHook() {
    const file = claudeSettings();
    const settings = readJson(file, {});
    if (fs.existsSync(file))
        fs.copyFileSync(file, `${file}.bak-grok-bot-bridge`);
    settings.hooks ??= {};
    const groups = (settings.hooks.Stop ??= []);
    for (const g of groups)
        g.hooks = g.hooks.filter((h) => !isOurs(h.command));
    settings.hooks.Stop = groups.filter((g) => g.hooks.length > 0);
    const command = hookCommand("claude").map((p) => JSON.stringify(p)).join(" ");
    settings.hooks.Stop.push({ hooks: [{ type: "command", command, timeout: 10 }] });
    ensureDir(path.dirname(file), 0o755);
    writeJsonAtomic(file, settings, 0o644);
    return [`Added Stop hook to ${file} (backup: settings.json.bak-grok-bot-bridge)`, warnIfEphemeral()].filter(Boolean);
}
export function uninstallClaudeHook() {
    const file = claudeSettings();
    const settings = readJson(file, {});
    const groups = settings.hooks?.Stop ?? [];
    const before = JSON.stringify(groups);
    for (const g of groups)
        g.hooks = g.hooks.filter((h) => !isOurs(h.command));
    if (settings.hooks)
        settings.hooks.Stop = groups.filter((g) => g.hooks.length > 0);
    if (JSON.stringify(settings.hooks?.Stop ?? []) === before)
        return "No grok-bot-bridge hook found in Claude Code settings.";
    writeJsonAtomic(file, settings, 0o644);
    return `Removed grok-bot-bridge Stop hook from ${file}`;
}
const codexConfig = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
export function installCodexNotify() {
    const file = codexConfig();
    const toml = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const cmd = hookCommand("codex");
    const line = `notify = [${cmd.map((c) => JSON.stringify(c)).join(", ")}]`;
    // Only look at top-level keys (before the first [table]).
    const topLevel = toml.split(/^\s*\[/m)[0];
    const existing = topLevel.match(/^\s*notify\s*=.*$/m);
    if (existing) {
        if (existing[0].includes("hook") && existing[0].includes("codex") && /grok-bot-bridge|gbb/.test(existing[0])) {
            return [`Codex notify already points at grok-bot-bridge in ${file}`];
        }
        throw new Error(`${file} already has a top-level notify program:\n  ${existing[0].trim()}\nCodex allows only one. Replace it with:\n  ${line}\n(or call gbb from your existing notify script: gbb hook codex '<json>')`);
    }
    ensureDir(path.dirname(file), 0o755);
    if (fs.existsSync(file))
        fs.copyFileSync(file, `${file}.bak-grok-bot-bridge`);
    fs.writeFileSync(file, `# grok-bot-bridge: forward watched-file handoffs to Grok Bot\n${line}\n\n${toml}`);
    return [`Added notify program to ${file}`, warnIfEphemeral()].filter(Boolean);
}
