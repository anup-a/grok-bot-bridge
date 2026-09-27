import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

let server;
let received = [];
let tmp;
let env;

function waitFor(pred, ms = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = pred();
      if (hit) return resolve(hit);
      if (Date.now() - start > ms) return reject(new Error("timed out waiting"));
      setTimeout(tick, 100);
    };
    tick();
  });
}

const gbb = (args, opts = {}) => run(process.execPath, [CLI, ...args], { env, ...opts });

/** Run gbb with data on stdin (and stdin closed). */
function gbbIn(args, input, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { ...env, ...extraEnv } }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stderr })) : resolve({ stdout, stderr }),
    );
    child.stdin.end(input);
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gbb-test-"));
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"success":true}');
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  env = {
    ...process.env,
    HOME: tmp,
    GBB_HOME: path.join(tmp, ".gbb"),
    GBB_NO_KEYCHAIN: "1",
    GBB_WEBHOOK_URL: `http://127.0.0.1:${port}/automations/webhook/test`,
    GBB_WEBHOOK_KEY: "test-key",
    GBB_SILENT: "",
  };
  fs.mkdirSync(env.GBB_HOME, { recursive: true });
  // A fake "echo" agent: prints stdin back. Plus a failing agent.
  fs.writeFileSync(
    path.join(env.GBB_HOME, "config.json"),
    JSON.stringify({
      agents: {
        echo: { command: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"] },
        fail: { command: [process.execPath, "-e", "console.error('boom'); process.exit(3)"] },
      },
    }),
  );
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("ping sends an authenticated event", async () => {
  received = [];
  await gbb(["ping"]);
  assert.equal(received.length, 1);
  assert.equal(received[0].auth, "Bearer test-key");
  assert.equal(received[0].body.event, "ping");
  assert.equal(received[0].body.source, "grok-bot-bridge");
  assert.match(received[0].body.text, /ping/);
});

test("notify sends a note with files", async () => {
  received = [];
  await gbb(["notify", "hello bot", "--file", "/tmp/x.md"]);
  assert.equal(received[0].body.event, "note");
  assert.equal(received[0].body.summary, "hello bot");
  assert.deepEqual(received[0].body.files, ["/tmp/x.md"]);
});

test("GBB_SILENT suppresses sends", async () => {
  received = [];
  await assert.rejects(gbb(["notify", "quiet"], { env: { ...env, GBB_SILENT: "1" } }));
  assert.equal(received.length, 0);
});

test("run executes the agent in the background and reports job_done", async () => {
  received = [];
  const { stdout } = await gbb(["run", "echo", "build the thing", "--cwd", tmp]);
  const { job_id } = JSON.parse(stdout);
  assert.match(job_id, /^j/);
  const msg = await waitFor(() => received.find((r) => r.body.job_id === job_id));
  assert.equal(msg.body.event, "job_done");
  assert.equal(msg.body.agent, "echo");
  assert.equal(msg.body.summary, "build the thing");
  assert.equal(msg.body.cwd, fs.realpathSync(tmp));
  const { stdout: result } = await gbb(["result", job_id]);
  assert.equal(result.trim(), "build the thing");
  const { stdout: status } = await gbb(["status", job_id]);
  assert.equal(JSON.parse(status).status, "done");
});

test("failing agent reports job_failed", async () => {
  received = [];
  const { stdout } = await gbb(["run", "fail", "x"]);
  const { job_id } = JSON.parse(stdout);
  const msg = await waitFor(() => received.find((r) => r.body.job_id === job_id));
  assert.equal(msg.body.event, "job_failed");
  assert.match(msg.body.summary, /boom/);
});

test("wait blocks until done; --no-notify stays quiet", async () => {
  received = [];
  const { stdout } = await gbb(["run", "echo", "quiet job", "--no-notify"]);
  const { job_id } = JSON.parse(stdout);
  const { stdout: waited } = await gbb(["wait", job_id, "--timeout", "15"]);
  assert.equal(JSON.parse(waited).status, "done");
  assert.equal(received.length, 0);
});

test("reply is rejected for non-resumable agents", async () => {
  const { stdout } = await gbb(["run", "echo", "x", "--no-notify"]);
  const { job_id } = JSON.parse(stdout);
  await gbb(["wait", job_id, "--timeout", "15"]);
  await assert.rejects(gbb(["reply", job_id, "more"]), /no session id|cannot resume/);
});

test("allowedRoots blocks other directories", async () => {
  const cfgPath = path.join(env.GBB_HOME, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfg, allowedRoots: [path.join(tmp, "allowed")] }));
  try {
    await assert.rejects(gbb(["run", "echo", "x", "--cwd", os.tmpdir()]), /outside allowedRoots/);
  } finally {
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  }
});

test("hook claude sends newly appended watched text once", async () => {
  const notes = path.join(tmp, "HANDOFF.md");
  fs.writeFileSync(notes, "# old history\n");
  await gbb(["watch", "add", notes]); // baselines existing content
  received = [];
  await gbbIn(["hook", "claude"], "{}");
  assert.equal(received.length, 0, "nothing new yet");

  fs.appendFileSync(notes, "\n## shipped the pricing page\n");
  await gbbIn(["hook", "claude"], JSON.stringify({ session_id: "s1", cwd: tmp }));
  const msg = await waitFor(() => received.find((r) => r.body.event === "handoff"));
  assert.equal(msg.body.summary, "## shipped the pricing page");
  assert.deepEqual(msg.body.files, [notes]);
  assert.equal(msg.body.session_id, "s1");

  received = [];
  await gbbIn(["hook", "claude"], "{}");
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(received.length, 0, "not re-sent");
});

test("hook inside a gbb job only advances the baseline", async () => {
  const notes = path.join(tmp, "HANDOFF.md");
  fs.appendFileSync(notes, "\nwritten by a job\n");
  received = [];
  await gbbIn(["hook", "claude"], "{}", { GBB_JOB_ID: "j1" });
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(received.length, 0);
});

test("install claude adds one Stop hook, idempotently", async () => {
  const settings = path.join(tmp, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "other" }] }] } }));
  await gbb(["install", "claude"]);
  await gbb(["install", "claude"]);
  const s = JSON.parse(fs.readFileSync(settings, "utf8"));
  const cmds = s.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
  assert.equal(cmds.filter((c) => c.includes("hook") && c.includes("claude") && c.includes("cli.js")).length, 1);
  assert.ok(cmds.includes("other"));
  await gbb(["uninstall", "claude"]);
  const s2 = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.deepEqual(s2.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command)), ["other"]);
});

test("install codex adds notify, refuses to clobber another", async () => {
  const cfg = path.join(tmp, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, 'model = "gpt-5"\n\n[tools]\nweb = true\n');
  await gbb(["install", "codex"]);
  const toml = fs.readFileSync(cfg, "utf8");
  assert.match(toml, /^notify = \[.*"hook", "codex"\]$/m);
  assert.ok(toml.indexOf("notify") < toml.indexOf("[tools]"));
  fs.writeFileSync(cfg, 'notify = ["my-script"]\n');
  await assert.rejects(gbb(["install", "codex"]), /already has a top-level notify/);
});

test("codex notify hook ignores other event types", async () => {
  received = [];
  const notes = path.join(tmp, "HANDOFF.md");
  fs.appendFileSync(notes, "\ncodex wrote this\n");
  await gbb(["hook", "codex", JSON.stringify({ type: "something-else" })]);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(received.length, 0);
  await gbb(["hook", "codex", JSON.stringify({ type: "agent-turn-complete", "thread-id": "t9", cwd: tmp })]);
  const msg = await waitFor(() => received.find((r) => r.body.event === "handoff"));
  assert.equal(msg.body.agent, "codex");
  assert.equal(msg.body.session_id, "t9");
});

test("rate limit caps sends per hour", async () => {
  const cfgPath = path.join(env.GBB_HOME, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const home2 = path.join(tmp, ".gbb-rl");
  fs.mkdirSync(home2);
  fs.writeFileSync(path.join(home2, "config.json"), JSON.stringify({ ...cfg, maxPerHour: 2 }));
  const e2 = { ...env, GBB_HOME: home2 };
  received = [];
  await gbb(["notify", "1"], { env: e2 });
  await gbb(["notify", "2"], { env: e2 });
  await assert.rejects(gbb(["notify", "3"], { env: e2 }), /rate limit/);
  assert.equal(received.length, 2);
});
