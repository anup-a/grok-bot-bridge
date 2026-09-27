import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAdapter } from "./agents.js";
import { ensureDir, homeDir, isInsideRoots, loadConfig, readJson, safeRealpath, writeJsonAtomic } from "./config.js";
import { buildPayload, send } from "./webhook.js";
const TERMINAL = ["done", "failed", "cancelled"];
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
export const jobsDir = () => ensureDir(path.join(homeDir(), "jobs"));
export const jobDir = (id) => path.join(jobsDir(), id);
const jobFile = (id) => path.join(jobDir(id), "job.json");
export function loadJob(id) {
    const job = readJson(jobFile(id), null);
    if (!job)
        throw new Error(`no such job: ${id}`);
    return job;
}
function saveJob(job) {
    writeJsonAtomic(jobFile(job.id), job);
}
function updateJob(id, patch) {
    const job = { ...loadJob(id), ...patch };
    saveJob(job);
    return job;
}
function newId() {
    return `j${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
}
/** Create a job and launch a detached worker. Returns immediately. */
export function startJob(opts) {
    const cfg = loadConfig();
    const adapter = getAdapter(opts.agent, cfg.agents); // validates agent name early
    const cwd = safeRealpath(opts.cwd ?? process.cwd());
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
        throw new Error(`cwd is not a directory: ${cwd}`);
    if (!isInsideRoots(cwd, cfg.allowedRoots)) {
        throw new Error(`cwd ${cwd} is outside allowedRoots (${cfg.allowedRoots?.join(", ")}). Edit ~/.grok-bot-bridge/config.json to allow it.`);
    }
    if (opts.resumeSessionId && !adapter.resumable)
        throw new Error(`agent "${adapter.name}" cannot resume sessions`);
    if (!opts.prompt.trim())
        throw new Error("prompt is empty");
    const job = {
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
export function replyToJob(id, message, opts = {}) {
    const parent = loadJob(id);
    if (!TERMINAL.includes(parent.status))
        throw new Error(`job ${id} is still ${parent.status}; wait for it first`);
    if (!parent.sessionId)
        throw new Error(`job ${id} has no session id to resume (agent ${parent.agent})`);
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
export function cancelJob(id) {
    const job = loadJob(id);
    if (TERMINAL.includes(job.status))
        return job;
    const updated = updateJob(id, { status: "cancelled", finishedAt: new Date().toISOString() });
    if (job.workerPid) {
        try {
            process.kill(-job.workerPid, "SIGTERM"); // worker is a process-group leader (detached)
        }
        catch {
            try {
                process.kill(job.workerPid, "SIGTERM");
            }
            catch {
                /* already gone */
            }
        }
    }
    return updated;
}
export function listJobs(limit = 20) {
    const dir = jobsDir();
    return fs
        .readdirSync(dir)
        .map((id) => readJson(path.join(dir, id, "job.json"), null))
        .filter((j) => j !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
}
export async function waitForJob(id, timeoutSec) {
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
        const job = loadJob(id);
        if (TERMINAL.includes(job.status) || Date.now() >= deadline)
            return job;
        await new Promise((r) => setTimeout(r, 1000));
    }
}
export function isTerminal(job) {
    return TERMINAL.includes(job.status);
}
/** Runs inside the detached worker process: execute the agent, record the outcome, notify the bot. */
export async function runWorker(id) {
    let job = loadJob(id);
    if (job.status !== "queued")
        return;
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
    const exitCode = await new Promise((resolve) => {
        const child = spawn(inv.command, inv.args, {
            cwd: job.cwd,
            stdio: ["pipe", out, err],
            env: { ...process.env, GBB_JOB_ID: id },
        });
        let timer;
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
            if (timer)
                clearTimeout(timer);
            process.off("SIGTERM", forward);
            resolve(code);
        });
        child.stdin?.on("error", () => { });
        child.stdin?.end(inv.stdin ?? "");
    });
    fs.closeSync(out);
    fs.closeSync(err);
    const stdout = fs.readFileSync(outPath, "utf8");
    const stderr = fs.readFileSync(errPath, "utf8");
    const outcome = adapter.parse(stdout, stderr, exitCode, spec);
    fs.writeFileSync(path.join(dir, "result.txt"), outcome.result + "\n", { mode: 0o600 });
    const current = loadJob(id);
    if (current.status === "cancelled")
        return;
    job = updateJob(id, {
        status: outcome.isError ? "failed" : "done",
        finishedAt: new Date().toISOString(),
        exitCode,
        sessionId: outcome.sessionId ?? job.sessionId,
        result: outcome.result,
        error: outcome.isError ? outcome.result.slice(0, 500) : undefined,
    });
    if (!job.notify)
        return;
    const next = [`gbb result ${id}`];
    if (adapter.resumable && job.sessionId)
        next.unshift(`gbb reply ${id} "<follow-up message>"`);
    await send(buildPayload(job.status === "done" ? "job_done" : "job_failed", outcome.result || "(no output)", {
        agent: job.agent,
        job_id: id,
        session_id: job.sessionId,
        cwd: job.cwd,
        prompt: job.prompt.length > 300 ? job.prompt.slice(0, 300) + "..." : job.prompt,
        duration_sec: job.startedAt ? Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000) : undefined,
        parent_job_id: job.parentId,
        reply_to: job.replyTo,
        next,
    }), { bot: job.bot });
}
