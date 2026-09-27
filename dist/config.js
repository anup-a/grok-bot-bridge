import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const DEFAULTS = {
    defaultBot: "default",
    maxPerHour: 12,
    agents: {},
    maxSummaryChars: 6000,
};
export const KEYCHAIN_SERVICE = "grok-bot-bridge";
export function homeDir() {
    return process.env.GBB_HOME || path.join(os.homedir(), ".grok-bot-bridge");
}
export function ensureDir(dir, mode = 0o700) {
    fs.mkdirSync(dir, { recursive: true, mode });
    return dir;
}
export function expandHome(p) {
    return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}
const configPath = () => path.join(homeDir(), "config.json");
export function loadConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
        return { ...DEFAULTS, ...raw, agents: { ...DEFAULTS.agents, ...(raw.agents ?? {}) } };
    }
    catch {
        return { ...DEFAULTS };
    }
}
export function saveConfig(cfg) {
    ensureDir(homeDir());
    writeJsonAtomic(configPath(), cfg);
}
export function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        return fallback;
    }
}
export function writeJsonAtomic(file, data, mode = 0o600) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
    fs.renameSync(tmp, file);
}
// ---------- credentials ----------
// Resolution order: env vars (GBB_WEBHOOK_URL / GBB_WEBHOOK_KEY, default bot only)
// -> macOS Keychain -> ~/.grok-bot-bridge/credentials.json (0600).
const useKeychain = () => process.platform === "darwin" && process.env.GBB_NO_KEYCHAIN !== "1";
const credsFile = () => path.join(homeDir(), "credentials.json");
function keychainGet(account) {
    try {
        return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    }
    catch {
        return undefined;
    }
}
function keychainSet(account, value) {
    execFileSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value], {
        stdio: "ignore",
    });
}
function keychainDelete(account) {
    try {
        execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account], { stdio: "ignore" });
    }
    catch {
        /* not present */
    }
}
export function getCredentials(bot, cfg = loadConfig()) {
    if (bot === cfg.defaultBot && process.env.GBB_WEBHOOK_URL && process.env.GBB_WEBHOOK_KEY) {
        return { url: process.env.GBB_WEBHOOK_URL, key: process.env.GBB_WEBHOOK_KEY };
    }
    if (useKeychain()) {
        const url = keychainGet(`${bot}:url`);
        const key = keychainGet(`${bot}:key`);
        if (url && key)
            return { url, key };
    }
    const file = readJson(credsFile(), {});
    return file[bot];
}
export function setCredentials(bot, creds) {
    if (useKeychain()) {
        keychainSet(`${bot}:url`, creds.url);
        keychainSet(`${bot}:key`, creds.key);
        return "keychain";
    }
    ensureDir(homeDir());
    const file = readJson(credsFile(), {});
    file[bot] = creds;
    writeJsonAtomic(credsFile(), file, 0o600);
    return "file";
}
export function deleteCredentials(bot) {
    if (useKeychain()) {
        keychainDelete(`${bot}:url`);
        keychainDelete(`${bot}:key`);
    }
    const file = readJson(credsFile(), {});
    if (file[bot]) {
        delete file[bot];
        writeJsonAtomic(credsFile(), file, 0o600);
    }
}
export function listBots(cfg = loadConfig()) {
    const bots = new Set(Object.keys(readJson(credsFile(), {})));
    for (const b of cfg.bots ?? [])
        bots.add(b);
    return [...bots];
}
export function rememberBot(bot) {
    const cfg = loadConfig();
    const bots = new Set(cfg.bots ?? []);
    bots.add(bot);
    cfg.bots = [...bots];
    // First bot configured becomes the default.
    if (!cfg.bots.includes(cfg.defaultBot))
        cfg.defaultBot = bot;
    saveConfig(cfg);
}
export function isInsideRoots(dir, roots) {
    if (!roots || roots.length === 0)
        return true;
    const real = safeRealpath(dir);
    return roots.some((r) => {
        const root = safeRealpath(expandHome(r));
        return real === root || real.startsWith(root + path.sep);
    });
}
export function safeRealpath(p) {
    try {
        return fs.realpathSync(p);
    }
    catch {
        return path.resolve(p);
    }
}
/** The connected Bot that relays messages to other Bots. */
export function hubBot(cfg = loadConfig()) {
    return cfg.hubBot ?? cfg.defaultBot;
}
