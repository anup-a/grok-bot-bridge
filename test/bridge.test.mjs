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

test("ask round-trips through the hub: hub runs gbb answer, asker prints it", async () => {
  received = [];
  const asking = gbb(["ask", "Health", "How did I sleep?", "--wait", "30"]);
  const msg = await waitFor(() => received.find((r) => r.body.event === "ask"));
  assert.equal(msg.body.to, "Health");
  assert.equal(msg.body.summary, "How did I sleep?");
  assert.match(msg.body.message_id, /^m/);
  assert.match(msg.body.next[0], new RegExp(`gbb answer ${msg.body.message_id}`));
  // Simulate the hub Bot delivering the answer through stdin (heredoc style).
  await gbbIn(["answer", msg.body.message_id, "-"], "Score 85, 8h10m.\nHRV 80.\n");
  const { stdout } = await asking;
  assert.equal(stdout.trim(), "Score 85, 8h10m.\nHRV 80.");
  const { stdout: inbox } = await gbb(["inbox", msg.body.message_id]);
  assert.equal(JSON.parse(inbox).to, "Health");
});

test("ask times out with exit code 2 and a pointer to the inbox", async () => {
  await assert.rejects(gbb(["ask", "Investing", "anything?", "--wait", "2"]), (e) => e.code === 2 && /gbb inbox m/.test(e.stderr));
});

test("tell sends a note addressed to another Bot", async () => {
  received = [];
  await gbb(["tell", "Health", "log 30 min walk"]);
  assert.equal(received[0].body.event, "note");
  assert.equal(received[0].body.to, "Health");
  assert.match(received[0].body.text, /note for Health/);
});

test("run --for tags the result with reply_to", async () => {
  received = [];
  const { stdout } = await gbb(["run", "echo", "summarize", "--for", "Growth"]);
  const { job_id } = JSON.parse(stdout);
  const msg = await waitFor(() => received.find((r) => r.body.job_id === job_id));
  assert.equal(msg.body.reply_to, "Growth");
});
