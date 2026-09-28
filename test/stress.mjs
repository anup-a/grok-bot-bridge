// Stress / failure-mode harness. Not part of `npm test` (slow). Run: npm run stress
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gbb-stress-"));
const HOME = path.join(tmp, "home");
fs.mkdirSync(HOME, { recursive: true });

// ---- fake webhook with switchable behaviour ----
let mode = "ok"; // ok | 500 | slow | down
let received = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (mode === "slow") return; // never answer; client must time out
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = { invalid: body.slice(0, 100) };
    }
    received.push({ auth: req.headers.authorization, body: parsed, bytes: body.length });
    if (mode === "500") {
      res.writeHead(500);
      return res.end("boom");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"success":true}');
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const baseEnv = {
  ...process.env,
  GBB_HOME: HOME,
  GBB_NO_KEYCHAIN: "1",
  GBB_WEBHOOK_URL: `http://127.0.0.1:${port}/automations/webhook/stress`,
  GBB_WEBHOOK_KEY: "stress-key",
  GBB_SILENT: "",
};
const writeConfig = (extra = {}) =>
  fs.writeFileSync(
    path.join(HOME, "config.json"),
    JSON.stringify({
      maxPerHour: 100000,
      agents: {
        cat: { command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"] },
        sh: { command: ["sh", "-c", "{prompt}"] },
        missing: { command: ["definitely-not-a-real-binary-gbb"] },
      },
      ...extra,
    }),
  );
writeConfig();

function gbb(args, { input, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { ...baseEnv, ...env }, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin.end(input ?? "");
  });
}
const json = (s) => JSON.parse(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 60000, every = 200) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await sleep(every);
  }
}
const status = async (id) => json((await gbb(["status", id])).stdout);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const results = [];
async function scenario(name, fn) {
  const t = Date.now();
  mode = "ok";
  received = [];
  writeConfig();
  try {
    const note = await fn();
    results.push({ name, ok: true, ms: Date.now() - t, note: note ?? "" });
    console.log(`PASS ${name} (${Date.now() - t}ms)${note ? `  ${note}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, note: e.message });
    console.log(`FAIL ${name} (${Date.now() - t}ms)  ${e.message.split("\n")[0]}`);
  }
}

// ---------------- scenarios ----------------

await scenario("30 concurrent jobs all finish, unique ids, one job_done each", async () => {
  const N = 30;
  const starts = await Promise.all(Array.from({ length: N }, (_, i) => gbb(["run", "cat", `job-${i}`])));
  const ids = starts.map((s) => json(s.stdout).job_id);
  assert.equal(new Set(ids).size, N, "duplicate job ids");
  await until(() => received.filter((r) => r.body.event === "job_done").length >= N, 120000);
  const done = received.filter((r) => r.body.event === "job_done");
  assert.equal(done.length, N);
  for (let i = 0; i < N; i++) assert.ok(done.some((d) => d.body.summary === `job-${i}`), `missing result job-${i}`);
  const list = json((await gbb(["list", "--json", "--limit", "100"])).stdout);
  assert.ok(list.filter((j) => j.status === "done").length >= N);
  return `${N} jobs`;
});

await scenario("rate limit holds under 20 concurrent sends (max 5/h)", async () => {
  writeConfig({ maxPerHour: 5 });
  const home2 = path.join(tmp, "rl");
  fs.mkdirSync(home2, { recursive: true });
  fs.copyFileSync(path.join(HOME, "config.json"), path.join(home2, "config.json"));
  await Promise.all(Array.from({ length: 20 }, (_, i) => gbb(["notify", `n${i}`], { env: { GBB_HOME: home2 } })));
  assert.ok(received.length <= 5, `rate limit leaked: ${received.length} sends got through`);
  return `${received.length} delivered`;
});

await scenario("5 MB of agent output: job done, payload truncated", async () => {
  const { stdout } = await gbb(["run", "sh", `${process.execPath} -e "process.stdout.write('x'.repeat(5*1024*1024))"`]);
  const id = json(stdout).job_id;
  const msg = await until(() => received.find((r) => r.body.job_id === id));
  assert.ok(msg.bytes < 50_000, `payload too big: ${msg.bytes} bytes`);
  const st = await status(id);
  assert.equal(st.status, "done");
  const jobJson = fs.statSync(path.join(HOME, "jobs", id, "job.json")).size;
  return `payload ${msg.bytes}B, job.json ${Math.round(jobJson / 1024)}KB`;
});

await scenario("prompt with quotes, unicode, newlines and $() round-trips exactly", async () => {
  const prompt = `He said "don't" & 'do' $(rm -rf /) \`x\` \\n 日本語 🚀\nline2\n\ttab`;
  const { stdout } = await gbb(["run", "cat"], { input: prompt });
  const id = json(stdout).job_id;
  await until(async () => (await status(id)).status === "done");
  const { stdout: result } = await gbb(["result", id]);
  assert.equal(result.replace(/\n$/, ""), prompt.trim());
});

await scenario("1 MB prompt via stdin", async () => {
  const prompt = "p".repeat(1024 * 1024);
  const { stdout } = await gbb(["run", "cat"], { input: prompt });
  const id = json(stdout).job_id;
  await until(async () => (await status(id)).status === "done");
  const r = fs.readFileSync(path.join(HOME, "jobs", id, "result.txt"), "utf8");
  assert.equal(r.trim().length, prompt.length);
});

await scenario("cancel kills the agent and its children, no notification", async () => {
  const marker = path.join(tmp, "grandchild.pid");
  const { stdout } = await gbb(["run", "sh", `sleep 60 & echo $! > ${marker}; wait`]);
  const id = json(stdout).job_id;
  await until(() => fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim());
  const grandchild = Number(fs.readFileSync(marker, "utf8"));
  const worker = (await status(id)).logs && json(fs.readFileSync(path.join(HOME, "jobs", id, "job.json"), "utf8")).workerPid;
  await gbb(["cancel", id]);
  await until(() => !alive(grandchild) && !alive(worker), 10000);
  await sleep(1500);
  assert.equal((await status(id)).status, "cancelled");
  assert.ok(!received.some((r) => r.body.job_id === id), "cancelled job still notified");
});

await scenario("--timeout kills a hung agent and reports job_failed", async () => {
  const { stdout } = await gbb(["run", "sh", "sleep 60", "--timeout", "2"]);
  const id = json(stdout).job_id;
  const msg = await until(() => received.find((r) => r.body.job_id === id), 20000);
  assert.equal(msg.body.event, "job_failed");
  assert.match(msg.body.summary, /timed out/);
});

await scenario("missing agent binary reports job_failed with a reason", async () => {
  const { stdout } = await gbb(["run", "missing", "x"]);
  const id = json(stdout).job_id;
  const msg = await until(() => received.find((r) => r.body.job_id === id));
  assert.equal(msg.body.event, "job_failed");
  assert.match(msg.body.summary, /failed to start|ENOENT/);
});

await scenario("webhook 500: job still done, failure logged", async () => {
  mode = "500";
  const { stdout } = await gbb(["run", "cat", "x"]);
  const id = json(stdout).job_id;
  await until(() => received.find((r) => r.body.job_id === id));
  await until(async () => (await status(id)).status === "done");
  const log = fs.readFileSync(path.join(HOME, "notify.log"), "utf8");
  assert.match(log, /failed 500/);
});

await scenario("webhook hangs: sender times out, job still done", async () => {
  mode = "slow";
  const t = Date.now();
  const r = await gbb(["notify", "hello"]);
  assert.notEqual(r.code, 0);
  const secs = (Date.now() - t) / 1000;
  assert.ok(secs < 30, `notify hung ${secs}s`);
  return `notify gave up after ${secs.toFixed(1)}s`;
});

await scenario("webhook down: notify fails fast with a clear error", async () => {
  const r = await gbb(["notify", "x"], { env: { GBB_WEBHOOK_URL: "http://127.0.0.1:1/nope" } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /failed|ECONNREFUSED|fetch/i);
});

await scenario("worker killed with SIGKILL: job does not stay 'running' forever", async () => {
  const { stdout } = await gbb(["run", "sh", "sleep 60"]);
  const id = json(stdout).job_id;
  await until(async () => (await status(id)).status === "running");
  const job = json(fs.readFileSync(path.join(HOME, "jobs", id, "job.json"), "utf8"));
  process.kill(-job.workerPid, "SIGKILL");
  await sleep(500);
  const st = await status(id);
  assert.equal(st.status, "failed", `status is ${st.status}`);
});

await scenario("corrupt config.json is an error, not silently ignored (allowedRoots bypass)", async () => {
  fs.writeFileSync(path.join(HOME, "config.json"), '{"allowedRoots": ["/nowhere"], oops');
  const run = await gbb(["run", "sh", "true", "--cwd", tmp]);
  const notify = await gbb(["notify", "x"]);
  writeConfig();
  assert.notEqual(run.code, 0, "job started despite unreadable config");
  assert.match(run.stderr, /invalid config/);
  assert.notEqual(notify.code, 0);
  assert.equal(received.length, 0);
});

await scenario("30 concurrent asks each get their own answer", async () => {
  const N = 30;
  const asks = Array.from({ length: N }, (_, i) => gbb(["ask", `Bot${i}`, `q${i}`, "--wait", "60"]));
  await until(() => received.filter((r) => r.body.event === "ask").length >= N);
  await Promise.all(
    received.filter((r) => r.body.event === "ask").map((r) => gbb(["answer", r.body.message_id, `answer-for-${r.body.summary}`])),
  );
  const outs = await Promise.all(asks);
  outs.forEach((o, i) => assert.equal(o.stdout.trim(), `answer-for-q${i}`, `ask ${i} got "${o.stdout.trim()}"`));
});

await scenario("state files stay valid JSON after the storm", async () => {
  for (const f of ["state.json", "config.json"]) JSON.parse(fs.readFileSync(path.join(HOME, f), "utf8"));
  for (const id of fs.readdirSync(path.join(HOME, "jobs"))) JSON.parse(fs.readFileSync(path.join(HOME, "jobs", id, "job.json"), "utf8"));
  for (const f of fs.readdirSync(path.join(HOME, "messages"))) JSON.parse(fs.readFileSync(path.join(HOME, "messages", f), "utf8"));
});

await scenario("gbb list stays fast with 500 jobs on disk", async () => {
  const jobsDir = path.join(HOME, "jobs");
  const sample = fs.readdirSync(jobsDir)[0];
  for (let i = 0; i < 500; i++) {
    const d = path.join(jobsDir, `jfake${i}`);
    fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(path.join(jobsDir, sample, "job.json"), path.join(d, "job.json"));
  }
  const t = Date.now();
  await gbb(["list"]);
  const ms = Date.now() - t;
  assert.ok(ms < 5000, `list took ${ms}ms`);
  return `${ms}ms`;
});

server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (process.env.KEEP !== "1") fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
