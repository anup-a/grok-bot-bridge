import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AgentConfig {
  /** Extra CLI args appended for every run (e.g. ["--permission-mode", "acceptEdits"]). */
  args?: string[];
  /** Custom agents only: command to run. "{prompt}" is replaced by the prompt; otherwise it goes to stdin. */
  command?: string[];
}

export interface Config {
  /** Bot used when --bot is not given. */
  defaultBot: string;
  /** If set, `gbb run` only accepts working directories inside these roots. */
  allowedRoots?: string[];
  /** Webhook sends allowed per bot per rolling hour (loop guard). */
  maxPerHour: number;
  /** Per-agent overrides and custom agents. */
  agents: Record<string, AgentConfig>;
  /** Max characters of agent output included in a webhook payload. */
  maxSummaryChars: number;
  /** Connected Bot that relays `ask`/`tell` to other Bots (defaults to defaultBot). */
  hubBot?: string;
  /** Names of bots configured via `gbb setup` (credentials live in Keychain or credentials.json). */
  bots?: string[];
}

export interface Credentials {
  url: string;
  key: string;
}

const DEFAULTS: Config = {
  defaultBot: "default",
  maxPerHour: 12,
  agents: {},
  maxSummaryChars: 6000,
};

export const KEYCHAIN_SERVICE = "grok-bot-bridge";

export function homeDir(): string {
  return process.env.GBB_HOME || path.join(os.homedir(), ".grok-bot-bridge");
}

export function ensureDir(dir: string, mode = 0o700): string {
  fs.mkdirSync(dir, { recursive: true, mode });
  return dir;
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

const configPath = () => path.join(homeDir(), "config.json");

export function loadConfig(): Config {
  let text: string;
  try {
    text = fs.readFileSync(configPath(), "utf8");
  } catch {
    return { ...DEFAULTS }; // no config yet
  }
  let raw: Partial<Config>;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    // Never fall back to defaults here: that would silently drop settings like allowedRoots.
    throw new Error(`invalid config at ${configPath()}: ${(e as Error).message}`);
  }
  return { ...DEFAULTS, ...raw, agents: { ...DEFAULTS.agents, ...(raw.agents ?? {}) } };
}

export function saveConfig(cfg: Config): void {
  ensureDir(homeDir());
  writeJsonAtomic(configPath(), cfg);
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Run fn while holding an exclusive lock file (cross-process). Stale locks (>10s) are broken. */
export function withLock<T>(name: string, fn: () => T): T {
  const lock = path.join(ensureDir(homeDir()), `${name}.lock`);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx", 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { force: true });
      } catch {
        /* lock vanished between checks */
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.random() * 20);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

export function writeJsonAtomic(file: string, data: unknown, mode = 0o600): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
  fs.renameSync(tmp, file);
}

// ---------- credentials ----------
// Resolution order: env vars (GBB_WEBHOOK_URL / GBB_WEBHOOK_KEY, default bot only)
// -> macOS Keychain -> ~/.grok-bot-bridge/credentials.json (0600).

const useKeychain = () => process.platform === "darwin" && process.env.GBB_NO_KEYCHAIN !== "1";
const credsFile = () => path.join(homeDir(), "credentials.json");

function keychainGet(account: string): string | undefined {
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function keychainSet(account: string, value: string): void {
  execFileSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value], {
    stdio: "ignore",
  });
}

function keychainDelete(account: string): void {
  try {
    execFileSync("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account], { stdio: "ignore" });
  } catch {
    /* not present */
  }
}

export function getCredentials(bot: string, cfg = loadConfig()): Credentials | undefined {
  if (bot === cfg.defaultBot && process.env.GBB_WEBHOOK_URL && process.env.GBB_WEBHOOK_KEY) {
    return { url: process.env.GBB_WEBHOOK_URL, key: process.env.GBB_WEBHOOK_KEY };
  }
  if (useKeychain()) {
    const url = keychainGet(`${bot}:url`);
    const key = keychainGet(`${bot}:key`);
    if (url && key) return { url, key };
  }
  const file = readJson<Record<string, Credentials>>(credsFile(), {});
  return file[bot];
}

export function setCredentials(bot: string, creds: Credentials): "keychain" | "file" {
  if (useKeychain()) {
    keychainSet(`${bot}:url`, creds.url);
    keychainSet(`${bot}:key`, creds.key);
    return "keychain";
  }
  ensureDir(homeDir());
  const file = readJson<Record<string, Credentials>>(credsFile(), {});
  file[bot] = creds;
  writeJsonAtomic(credsFile(), file, 0o600);
  return "file";
}

export function deleteCredentials(bot: string): void {
  if (useKeychain()) {
    keychainDelete(`${bot}:url`);
    keychainDelete(`${bot}:key`);
  }
  const file = readJson<Record<string, Credentials>>(credsFile(), {});
  if (file[bot]) {
    delete file[bot];
    writeJsonAtomic(credsFile(), file, 0o600);
  }
}

export function listBots(cfg = loadConfig()): string[] {
  const bots = new Set<string>(Object.keys(readJson<Record<string, Credentials>>(credsFile(), {})));
  for (const b of cfg.bots ?? []) bots.add(b);
  return [...bots];
}

export function rememberBot(bot: string): void {
  const cfg = loadConfig();
  const bots = new Set(cfg.bots ?? []);
  bots.add(bot);
  cfg.bots = [...bots];
  // First bot configured becomes the default.
  if (!cfg.bots.includes(cfg.defaultBot)) cfg.defaultBot = bot;
  saveConfig(cfg);
}

export function isInsideRoots(dir: string, roots: string[] | undefined): boolean {
  if (!roots || roots.length === 0) return true;
  const real = safeRealpath(dir);
  return roots.some((r) => {
    const root = safeRealpath(expandHome(r));
    return real === root || real.startsWith(root + path.sep);
  });
}

export function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The connected Bot that relays messages to other Bots. */
export function hubBot(cfg = loadConfig()): string {
  return cfg.hubBot ?? cfg.defaultBot;
}
