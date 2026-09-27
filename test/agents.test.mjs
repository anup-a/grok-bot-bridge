import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { claude, codex, custom } from "../dist/agents.js";

const spec = (extra = {}) => ({ prompt: "do it", jobDir: fs.mkdtempSync(path.join(os.tmpdir(), "gbb-a-")), extraArgs: [], ...extra });

test("claude builds print-mode JSON invocation with resume", () => {
  const inv = claude.build(spec({ resumeSessionId: "abc", extraArgs: ["--permission-mode", "acceptEdits"] }));
  assert.equal(inv.command, "claude");
  assert.deepEqual(inv.args, ["-p", "--output-format", "json", "--resume", "abc", "--permission-mode", "acceptEdits"]);
  assert.equal(inv.stdin, "do it");
});

test("claude parses result JSON", () => {
  const out = claude.parse('{"type":"result","result":"All done","session_id":"s-1","is_error":false}', "", 0, spec());
  assert.deepEqual(out, { result: "All done", sessionId: "s-1", isError: false });
  const bad = claude.parse("not json", "stack trace", 1, spec());
  assert.equal(bad.isError, true);
  assert.equal(bad.result, "not json");
});

test("codex builds exec and resume invocations", () => {
  const s = spec();
  assert.deepEqual(codex.build(s).args.slice(0, 3), ["exec", "--json", "--skip-git-repo-check"]);
  const r = codex.build(spec({ resumeSessionId: "t-1" })).args;
  assert.deepEqual(r.slice(0, 2), ["exec", "resume"]);
  assert.deepEqual(r.slice(-2), ["t-1", "-"]);
});

test("codex parses thread id and last message file", () => {
  const s = spec();
  fs.writeFileSync(path.join(s.jobDir, "last-message.txt"), "Final answer\n");
  const stdout = ['{"type":"thread.started","thread_id":"t-42"}', '{"type":"turn.completed"}'].join("\n");
  assert.deepEqual(codex.parse(stdout, "", 0, s), { result: "Final answer", sessionId: "t-42", isError: false });
  const failed = codex.parse('{"type":"turn.failed","error":{"message":"x"}}', "err", 0, spec());
  assert.equal(failed.isError, true);
});

test("custom agent substitutes {prompt} or uses stdin", () => {
  const a = custom("aider", { command: ["aider", "--message", "{prompt}"] });
  assert.deepEqual(a.build(spec()), { command: "aider", args: ["--message", "do it"], stdin: undefined });
  const b = custom("x", { command: ["x", "--go"] });
  assert.equal(b.build(spec()).stdin, "do it");
  assert.equal(a.resumable, false);
});
