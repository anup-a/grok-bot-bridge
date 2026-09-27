#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { knownAgents } from "./agents.js";
import {
  deleteCredentials,
  expandHome,
  getCredentials,
  homeDir,
  listBots,
  loadConfig,
  rememberBot,
  saveConfig,
  setCredentials,
} from "./config.js";
import { agentInstructions, routinePrompt } from "./grok.js";
import { collectAppended, handleHook, installClaudeHook, installCodexNotify, uninstallClaudeHook } from "./hooks.js";
import { cancelJob, isTerminal, jobDir, listJobs, loadJob, replyToJob, runWorker, startJob, waitForJob, type Job } from "./jobs.js";
import { buildPayload, logFile, send, VERSION, type Payload } from "./webhook.js";

const HELP = `grok-bot-bridge ${VERSION}: two-way bridge between Grok Bot and local coding agents

Setup
  gbb setup [--bot NAME] [--url URL --key KEY]   connect a Grok Bot webhook routine (prints the chat message to create it)
  gbb prompt                                      print the message that asks your Bot to create the routine
  gbb install claude | codex                      notify the Bot when agents append to watched files
  gbb watch add|rm|list [FILE]                    files whose new text is sent as a "handoff" event
  gbb doctor                                      check config, credentials and agent CLIs

Agent -> Grok Bot
  gbb notify "text" [--event note] [--file PATH]  send a message to the Bot (text from stdin if omitted)
  gbb ping                                        send a test event

Grok Bot -> agent (the Bot runs these on your computer)
  gbb run AGENT "task" [--cwd DIR] [--timeout SEC] [--no-notify] [-- AGENT_ARGS...]
                                                  start a background job, print its id, report back when done
  gbb reply JOB "message"                         continue that job's agent session
  gbb status JOB | result JOB | wait JOB [--timeout SEC] | cancel JOB
  gbb list [--limit N] [--json]                   recent jobs
  gbb agents                                      available agents (claude, codex, custom)
  gbb instructions                                print the usage guide to give your Bot

Options: --bot NAME picks a configured bot (default from config). GBB_SILENT=1 suppresses sends.
Config: ${path.join("~", ".grok-bot-bridge", "config.json")}   Log: ~/.grok-bot-bridge/notify.log`;

interface Parsed {
  pos: string[];
  flags: Record<string, string | boolean>;
  multi: Record<string, string[]>;
  rest: string[];
}

const VALUE_FLAGS = new Set(["cwd", "bot", "timeout", "event", "file", "url", "key", "limit"]);

function parse(argv: string[]): Parsed {
  const out: Parsed = { pos: [], flags: {}, multi: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (VALUE_FLAGS.has(name)) {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new Error(`--${name} needs a value`);
        out.flags[name] = v;
        (out.multi[name] ??= []).push(v);
      } else {
        out.flags[name] = true;
      }
    } else if (a === "-h") {
      out.flags.help = true;
    } else {
      out.pos.push(a);
    }
  }
  return out;
}

const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);
const num = (v: string | boolean | undefined) => (typeof v === "string" ? Number(v) : undefined);

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function print(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function jobView(j: Job) {
  return {
    id: j.id,
    agent: j.agent,
    status: j.status,
    cwd: j.cwd,
    session_id: j.sessionId,
    parent_job_id: j.parentId,
    created_at: j.createdAt,
    started_at: j.startedAt,
    finished_at: j.finishedAt,
    exit_code: j.exitCode,
    result: j.result,
    logs: jobDir(j.id),
  };
}

function reportSend(r: Awaited<ReturnType<typeof send>>): number {
  if (r.ok) {
    console.log(`sent (${r.status})`);
    return 0;
  }
  console.error(r.skipped ? `not sent: ${r.skipped}` : `failed: ${r.status ?? ""} ${r.body ?? ""}`.trim());
  return 1;
}

function copyToClipboard(text: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("pbcopy", { input: text });
    return true;
  } catch {
    return false;
  }
}

async function setup(p: Parsed): Promise<number> {
  const cfg = loadConfig();
  const bot = str(p.flags.bot) ?? (cfg.bots?.length ? cfg.defaultBot : "default");
  let url = str(p.flags.url);
  let key = str(p.flags.key);

  if (!url || !key) {
    const prompt = routinePrompt();
    console.log("Step 1. Send this message to your Grok Bot (in the chat of the Bot you want to connect):\n");
    console.log(prompt.replace(/^/gm, "  "));
    if (copyToClipboard(prompt)) console.log("\n(Copied to clipboard.)");
    console.log(
      `\nStep 2. Open the new routine's panel in Grok Bot (click the "Created routine" chip) and copy the Webhook URL and key.\n`,
    );
    if (!process.stdin.isTTY) {
      console.log(`Then run: gbb setup --bot ${bot} --url <webhook url> --key <webhook key>`);
      return 0;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    url ||= (await rl.question("Webhook URL: ")).trim();
    key ||= (await rl.question("Webhook key: ")).trim();
    rl.close();
  }
  if (!/^https:\/\//.test(url)) throw new Error("webhook URL must start with https://");
  if (!key) throw new Error("webhook key is empty");
  const where = setCredentials(bot, { url, key });
  rememberBot(bot);
  console.log(`Saved credentials for bot "${bot}" (${where === "keychain" ? "macOS Keychain" : path.join(homeDir(), "credentials.json")}).`);
  if (p.flags["no-test"]) return 0;
  const r = await send(buildPayload("ping", "grok-bot-bridge setup test. Reply PONG."), { bot, force: true });
  if (r.ok) console.log(`Test ping delivered (${r.status}). Your Bot should reply PONG in its chat.`);
  else console.error(`Test ping failed: ${r.skipped ?? `${r.status ?? ""} ${r.body ?? ""}`}`);
  return r.ok ? 0 : 1;
}

function doctor(): number {
  const cfg = loadConfig();
  const lines: string[] = [`grok-bot-bridge ${VERSION}`, `home: ${homeDir()}`];
  const bots = listBots(cfg);
  if (bots.length === 0) lines.push("bots: none configured (run: gbb setup)");
  for (const b of bots) lines.push(`bot ${b}${b === cfg.defaultBot ? " (default)" : ""}: ${getCredentials(b, cfg) ? "credentials ok" : "MISSING credentials"}`);
  for (const a of knownAgents(cfg.agents)) {
    const bin = cfg.agents[a]?.command?.[0] ?? a;
    let v = "not found on PATH";
    try {
      v = execFileSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim().split("\n")[0];
    } catch {
      /* missing */
    }
    lines.push(`agent ${a}: ${v}`);
  }
  lines.push(`watch: ${cfg.watch.length ? cfg.watch.join(", ") : "(none)"}`);
  lines.push(`allowedRoots: ${cfg.allowedRoots?.length ? cfg.allowedRoots.join(", ") : "(any directory)"}`);
  lines.push(`rate limit: ${cfg.maxPerHour}/hour per bot`);
  console.log(lines.join("\n"));
  return bots.length && bots.every((b) => getCredentials(b, cfg)) ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const p = parse(argv);
  const [cmd, ...args] = p.pos;
  const bot = str(p.flags.bot);
  if (!cmd || p.flags.help || cmd === "help") {
    console.log(HELP);
    return 0;
  }

  switch (cmd) {
    case "version":
    case "--version":
      console.log(VERSION);
      return 0;

    case "setup":
      return setup(p);

    case "prompt":
      console.log(routinePrompt());
      return 0;

    case "instructions":
      console.log(agentInstructions());
      return 0;

    case "ping":
      return reportSend(await send(buildPayload("ping", "Test from grok-bot-bridge. Reply PONG."), { bot, force: true }));

    case "notify": {
      const text = args.join(" ") || (await readStdin());
      if (!text.trim()) throw new Error('nothing to send: gbb notify "text"');
      const files = (p.multi.file ?? []).map((f) => path.resolve(expandHome(f)));
      const payload = buildPayload(str(p.flags.event) ?? "note", text, { cwd: process.cwd(), files, agent: process.env.GBB_AGENT });
      return reportSend(await send(payload, { bot }));
    }

    case "run": {
      const [agent, ...words] = args;
      if (!agent) throw new Error('usage: gbb run AGENT "task" [--cwd DIR]');
      const prompt = words.join(" ") || (await readStdin());
      const job = startJob({
        agent,
        prompt,
        cwd: str(p.flags.cwd) ? path.resolve(expandHome(str(p.flags.cwd)!)) : undefined,
        bot,
        notify: !p.flags["no-notify"],
        timeoutSec: num(p.flags.timeout),
        extraArgs: p.rest,
      });
      print({ job_id: job.id, agent: job.agent, status: job.status, cwd: job.cwd, next: [`gbb status ${job.id}`, `gbb wait ${job.id} --timeout 60`] });
      return 0;
    }

    case "reply": {
      const [id, ...words] = args;
      if (!id) throw new Error('usage: gbb reply JOB "message"');
      const message = words.join(" ") || (await readStdin());
      const job = replyToJob(id, message, { bot, notify: p.flags["no-notify"] ? false : undefined, timeoutSec: num(p.flags.timeout), extraArgs: p.rest });
      print({ job_id: job.id, parent_job_id: id, agent: job.agent, status: job.status, session_id: job.resumeSessionId });
      return 0;
    }

    case "status":
      if (!args[0]) throw new Error("usage: gbb status JOB");
      print(jobView(loadJob(args[0])));
      return 0;

    case "result": {
      if (!args[0]) throw new Error("usage: gbb result JOB");
      const job = loadJob(args[0]);
      if (!isTerminal(job)) {
        console.error(`job ${job.id} is ${job.status}`);
        return 2;
      }
      console.log(job.result ?? "");
      return job.status === "done" ? 0 : 1;
    }

    case "wait": {
      if (!args[0]) throw new Error("usage: gbb wait JOB [--timeout SEC]");
      const job = await waitForJob(args[0], num(p.flags.timeout) ?? 600);
      print(jobView(job));
      return isTerminal(job) ? (job.status === "done" ? 0 : 1) : 2;
    }

    case "cancel":
      if (!args[0]) throw new Error("usage: gbb cancel JOB");
      print(jobView(cancelJob(args[0])));
      return 0;

    case "list": {
      const jobs = listJobs(num(p.flags.limit) ?? 20);
      if (p.flags.json) {
        print(jobs.map(jobView));
        return 0;
      }
      if (!jobs.length) console.log("no jobs yet");
      for (const j of jobs) {
        const firstLine = j.prompt.split("\n")[0];
        console.log(`${j.id}  ${j.status.padEnd(9)} ${j.agent.padEnd(7)} ${j.createdAt.slice(0, 16).replace("T", " ")}  ${firstLine.slice(0, 60)}`);
      }
      return 0;
    }

    case "agents":
      console.log(knownAgents(loadConfig().agents).join("\n"));
      return 0;

    case "watch": {
      const [sub, file] = args;
      const cfg = loadConfig();
      if (sub === "add" || sub === "rm") {
        if (!file) throw new Error(`usage: gbb watch ${sub} FILE`);
        const abs = path.resolve(expandHome(file));
        cfg.watch = cfg.watch.filter((f) => path.resolve(expandHome(f)) !== abs);
        if (sub === "add") cfg.watch.push(abs);
        saveConfig(cfg);
        if (sub === "add") collectAppended(cfg.watch); // baseline: existing content is not sent
      }
      console.log(cfg.watch.length ? cfg.watch.join("\n") : "(no watched files)");
      return 0;
    }

    case "install": {
      if (args[0] === "claude") console.log(installClaudeHook().join("\n"));
      else if (args[0] === "codex") console.log(installCodexNotify().join("\n"));
      else throw new Error("usage: gbb install claude | codex");
      if (!loadConfig().watch.length) console.log('Tip: hooks only fire for watched files. Add one: gbb watch add ./HANDOFF.md');
      return 0;
    }

    case "uninstall":
      if (args[0] !== "claude") throw new Error("usage: gbb uninstall claude (for codex, remove the notify line from ~/.codex/config.toml)");
      console.log(uninstallClaudeHook());
      return 0;

    case "hook": {
      const source = args[0];
      if (source !== "claude" && source !== "codex") throw new Error("usage: gbb hook claude|codex");
      const input = source === "codex" ? (args[1] ?? "") : await readStdin();
      handleHook(source, input);
      return 0;
    }

    case "bots": {
      const cfg = loadConfig();
      for (const b of listBots(cfg)) console.log(`${b}${b === cfg.defaultBot ? " (default)" : ""}`);
      return 0;
    }

    case "logout": {
      const cfg = loadConfig();
      const name = bot ?? cfg.defaultBot;
      deleteCredentials(name);
      cfg.bots = (cfg.bots ?? []).filter((b) => b !== name);
      saveConfig(cfg);
      console.log(`Removed credentials for bot "${name}".`);
      return 0;
    }

    case "doctor":
      return doctor();

    case "config":
      console.log(path.join(homeDir(), "config.json"));
      print(loadConfig());
      return 0;

    // ----- internal -----
    case "_worker":
      await runWorker(args[0]);
      return 0;

    case "_send": {
      const file = args[0];
      const payload = JSON.parse(fs.readFileSync(file, "utf8")) as Payload;
      const r = await send(payload, { bot });
      if (r.ok || r.skipped) fs.rmSync(file, { force: true });
      return r.ok ? 0 : 1;
    }

    default:
      throw new Error(`unknown command "${cmd}". Run: gbb help`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`gbb: ${err.message}`);
    process.exit(1);
  },
);
