import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAdapter } from "./agents.js";
import { ensureDir, homeDir, isInsideRoots, loadConfig, readJson, safeRealpath, writeJsonAtomic } from "./config.js";
import { buildPayload, send } from "./webhook.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  agent: string;
  prompt: string;
  cwd: string;
  bot: string;
  status: JobStatus;
  notify: boolean;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  workerPid?: number;
  exitCode?: number | null;
  sessionId?: string;
  resumeSessionId?: string;
  parentId?: string;
  /** Bot that asked for this job; the hub forwards the result to it. */
  replyTo?: string;
  timeoutSec?: number;
  extraArgs: string[];
  result?: string;
  error?: string;
}

const TERMINAL: JobStatus[] = ["done", "failed", "cancelled"];
const MAX_STORED_RESULT = 20_000;
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

export const jobsDir = () => ensureDir(path.join(homeDir(), "jobs"));
export const jobDir = (id: string) => path.join(jobsDir(), id);
const jobFile = (id: string) => path.join(jobDir(id), "job.json");

export function loadJob(id: string): Job {
  const job = readJson<Job | null>(jobFile(id), null);
  if (!job) throw new Error(`no such job: ${id}`);
  return job;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A job whose worker died (crash, SIGKILL, reboot) is marked failed instead of staying "running" forever. */
function reconcile(job: Job): Job {
  if (TERMINAL.includes(job.status) || !job.workerPid || isAlive(job.workerPid)) return job;
  const fresh = loadJob(job.id); // the worker may have finished between our read and the liveness check
  if (TERMINAL.includes(fresh.status)) return fresh;
  return updateJob(job.id, {
    status: "failed",
    finishedAt: new Date().toISOString(),
    error: "worker exited unexpectedly (killed, crashed, or the machine restarted)",
    result: fresh.result ?? "worker exited unexpectedly",
  });
}

/** Load a job for display, detecting dead workers. */
export function getJob(id: string): Job {
  return reconcile(loadJob(id));
}

/** Full agent output (job.json keeps a capped copy). */
export function jobResult(id: string): string {
  try {
    return fs.readFileSync(path.join(jobDir(id), "result.txt"), "utf8").replace(/\n$/, "");
  } catch {
    return loadJob(id).result ?? "";
  }
}

function saveJob(job: Job): void {
  writeJsonAtomic(jobFile(job.id), job);
}

function updateJob(id: string, patch: Partial<Job>): Job {
  const job = { ...loadJob(id), ...patch };
  saveJob(job);
  return job;
}

function newId(): string {
  return `j${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
}

export interface StartOptions {
  agent: string;
  prompt: string;
  cwd?: string;
  bot?: string;
  notify?: boolean;
  timeoutSec?: number;
  extraArgs?: string[];
  resumeSessionId?: string;
  parentId?: string;
  replyTo?: string;
}

/** Create a job and launch a detached worker. Returns immediately. */
export function startJob(opts: StartOptions): Job {
  const cfg = loadConfig();
  const adapter = getAdapter(opts.agent, cfg.agents); // validates agent name early
  const cwd = safeRealpath(opts.cwd ?? process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  if (!isInsideRoots(cwd, cfg.allowedRoots)) {
    throw new Error(`cwd ${cwd} is outside allowedRoots (${cfg.allowedRoots?.join(", ")}). Edit ~/.grok-bot-bridge/config.json to allow it.`);
  }
  if (opts.resumeSessionId && !adapter.resumable) throw new Error(`agent "${adapter.name}" cannot resume sessions`);
  if (!opts.prompt.trim()) throw new Error("prompt is empty");

  const job: Job = {
    id: newId(),
    agent: adapter.name,
    prompt: opts.prompt,
    cwd,
    bot: opts.bot ?? cfg.defaultBot,
    status: "queued",
    notify: opts.notify ?? true,
    createdAt: new Date().toISOString(),
    timeoutSec: opts.timeoutSec,
    extraArgs: [...(cfg.agents[adapter.name]?.args ?? []), ...(opts.extraArgs ?? [])],
    resumeSessionId: opts.resumeSessionId,
    parentId: opts.parentId,
    replyTo: opts.replyTo,
  };
  ensureDir(jobDir(job.id));
  saveJob(job);

  const worker = spawn(process.execPath, [CLI, "_worker", job.id], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  worker.unref();
  return updateJob(job.id, { workerPid: worker.pid });
}

/** Continue a finished job's agent session with a follow-up message (new job, same session). */
export function replyToJob(id: string, message: string, opts: Omit<StartOptions, "agent" | "prompt" | "resumeSessionId" | "parentId"> = {}): Job {
  const parent = getJob(id);
  if (!TERMINAL.includes(parent.status)) throw new Error(`job ${id} is still ${parent.status}; wait for it first`);
  if (!parent.sessionId) throw new Error(`job ${id} has no session id to resume (agent ${parent.agent})`);
  return startJob({
    agent: parent.agent,
    prompt: message,
    cwd: opts.cwd ?? parent.cwd,
    bot: opts.bot ?? parent.bot,
    notify: opts.notify ?? parent.notify,
    timeoutSec: opts.timeoutSec ?? parent.timeoutSec,
    extraArgs: opts.extraArgs,
    resumeSessionId: parent.sessionId,
    parentId: parent.id,
    replyTo: opts.replyTo ?? parent.replyTo,
  });
}

export function cancelJob(id: string): Job {
  const job = loadJob(id);
  if (TERMINAL.includes(job.status)) return job;
  const updated = updateJob(id, { status: "cancelled", finishedAt: new Date().toISOString() });
  if (job.workerPid) {
    try {
      process.kill(-job.workerPid, "SIGTERM"); // worker is a process-group leader (detached)
    } catch {
      try {
        process.kill(job.workerPid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  return updated;
}

export function listJobs(limit = 20): Job[] {
  // Ids start with a base36 timestamp, so name order is creation order: read only what we show.
  const ids = fs.readdirSync(jobsDir()).sort().reverse();
  const out: Job[] = [];
  for (const id of ids) {
    if (out.length >= limit) break;
    const job = readJson<Job | null>(jobFile(id), null);
    if (job) out.push(reconcile(job));
  }
  return out;
}

export async function waitForJob(id: string, timeoutSec: number): Promise<Job> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const job = getJob(id);
    if (TERMINAL.includes(job.status) || Date.now() >= deadline) return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function isTerminal(job: Job): boolean {
  return TERMINAL.includes(job.status);
}

/** Runs inside the detached worker process: execute the agent, record the outcome, notify the bot. */
export async function runWorker(id: string): Promise<void> {
  let job = loadJob(id);
  if (job.status !== "queued") return;
  const cfg = loadConfig();
  const adapter = getAdapter(job.agent, cfg.agents);
  const dir = jobDir(id);
  const spec = { prompt: job.prompt, resumeSessionId: job.resumeSessionId, jobDir: dir, extraArgs: job.extraArgs };
  const inv = adapter.build(spec);

  job = updateJob(id, { status: "running", startedAt: new Date().toISOString(), workerPid: process.pid });
  const outPath = path.join(dir, "stdout.log");
  const errPath = path.join(dir, "stderr.log");
  const out = fs.openSync(outPath, "w", 0o600);
  const err = fs.openSync(errPath, "w", 0o600);

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(inv.command, inv.args, {
      cwd: job.cwd,
      stdio: ["pipe", out, err],
      env: { ...process.env, GBB_JOB_ID: id },
    });
    let timer: NodeJS.Timeout | undefined;
    if (job.timeoutSec) {
      timer = setTimeout(() => {
        fs.appendFileSync(errPath, `\n[grok-bot-bridge] timed out after ${job.timeoutSec}s\n`);
        child.kill("SIGTERM");
      }, job.timeoutSec * 1000);
    }
    const forward = () => child.kill("SIGTERM");
    process.once("SIGTERM", forward);
    child.on("error", (e) => {
      fs.appendFileSync(errPath, `\n[grok-bot-bridge] failed to start ${inv.command}: ${e.message}\n`);
      resolve(127);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      process.off("SIGTERM", forward);
      resolve(code);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(inv.stdin ?? "");
  });
  fs.closeSync(out);
  fs.closeSync(err);

  const stdout = fs.readFileSync(outPath, "utf8");
  const stderr = fs.readFileSync(errPath, "utf8");
  const outcome = adapter.parse(stdout, stderr, exitCode, spec);
  fs.writeFileSync(path.join(dir, "result.txt"), outcome.result + "\n", { mode: 0o600 });

  const current = loadJob(id);
  if (current.status === "cancelled") return;
  job = updateJob(id, {
    status: outcome.isError ? "failed" : "done",
    finishedAt: new Date().toISOString(),
    exitCode,
    sessionId: outcome.sessionId ?? job.sessionId,
    // result.txt has the full output; keep job.json small.
    result: outcome.result.length > MAX_STORED_RESULT ? outcome.result.slice(-MAX_STORED_RESULT) : outcome.result,
    error: outcome.isError ? outcome.result.slice(-500) : undefined,
  });

  if (!job.notify) return;
  const next = [`gbb result ${id}`];
  if (adapter.resumable && job.sessionId) next.unshift(`gbb reply ${id} "<follow-up message>"`);
  await send(
    buildPayload(job.status === "done" ? "job_done" : "job_failed", outcome.result || "(no output)", {
      agent: job.agent,
      job_id: id,
      session_id: job.sessionId,
      cwd: job.cwd,
      prompt: job.prompt.length > 300 ? job.prompt.slice(0, 300) + "..." : job.prompt,
      duration_sec: job.startedAt ? Math.round((Date.parse(job.finishedAt!) - Date.parse(job.startedAt)) / 1000) : undefined,
      parent_job_id: job.parentId,
      reply_to: job.replyTo,
      next,
    }),
    { bot: job.bot },
  );
}
