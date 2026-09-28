import fs from "node:fs";
import path from "node:path";
function tail(s, n = 4000) {
    const t = s.trim();
    return t.length > n ? "..." + t.slice(-n) : t;
}
/** Claude Code: `claude -p --output-format json`, prompt on stdin, `--resume <session>` for replies. */
export const claude = {
    name: "claude",
    resumable: true,
    build(spec) {
        const args = ["-p", "--output-format", "json"];
        if (spec.resumeSessionId)
            args.push("--resume", spec.resumeSessionId);
        args.push(...spec.extraArgs);
        return { command: "claude", args, stdin: spec.prompt };
    },
    parse(stdout, stderr, exitCode) {
        // Output is a single JSON object; be tolerant of stray lines before it.
        const start = stdout.indexOf("{");
        if (start >= 0) {
            try {
                const j = JSON.parse(stdout.slice(start));
                return {
                    result: String(j.result ?? j.error ?? "").trim() || tail(stderr),
                    sessionId: j.session_id,
                    isError: Boolean(j.is_error) || exitCode !== 0,
                };
            }
            catch {
                /* fall through */
            }
        }
        return { result: tail(stdout) || tail(stderr), isError: exitCode !== 0 };
    },
};
/** OpenAI Codex CLI: `codex exec --json -o <file> -`, `codex exec resume <id>` for replies. */
export const codex = {
    name: "codex",
    resumable: true,
    build(spec) {
        const lastMsg = path.join(spec.jobDir, "last-message.txt");
        const args = spec.resumeSessionId
            ? ["exec", "resume", "--json", "--skip-git-repo-check", "-o", lastMsg, ...spec.extraArgs, spec.resumeSessionId, "-"]
            : ["exec", "--json", "--skip-git-repo-check", "-o", lastMsg, ...spec.extraArgs, "-"];
        return { command: "codex", args, stdin: spec.prompt };
    },
    parse(stdout, stderr, exitCode, spec) {
        let sessionId;
        let failed = false;
        let lastAgentText = "";
        for (const line of stdout.split("\n")) {
            if (!line.startsWith("{"))
                continue;
            try {
                const ev = JSON.parse(line);
                if (ev.type === "thread.started" && ev.thread_id)
                    sessionId = ev.thread_id;
                if (ev.type === "turn.failed" || ev.type === "error")
                    failed = true;
                if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text)
                    lastAgentText = ev.item.text;
            }
            catch {
                /* ignore */
            }
        }
        let result = "";
        try {
            result = fs.readFileSync(path.join(spec.jobDir, "last-message.txt"), "utf8").trim();
        }
        catch {
            /* no file */
        }
        result ||= lastAgentText || tail(stderr);
        return { result, sessionId: sessionId ?? spec.resumeSessionId, isError: failed || exitCode !== 0 };
    },
};
/** Any other CLI from config: { "command": ["aider", "--message", "{prompt}"] }. Not resumable. */
export function custom(name, cfg) {
    const cmd = cfg.command ?? [];
    if (cmd.length === 0)
        throw new Error(`agent "${name}" has no "command" in config`);
    return {
        name,
        resumable: false,
        build(spec) {
            const usesArg = cmd.some((c) => c.includes("{prompt}"));
            const args = cmd.slice(1).map((c) => c.replaceAll("{prompt}", spec.prompt));
            return { command: cmd[0], args: [...args, ...spec.extraArgs], stdin: usesArg ? undefined : spec.prompt };
        },
        parse(stdout, stderr, exitCode) {
            return { result: stdout.trim() || tail(stderr), isError: exitCode !== 0 };
        },
    };
}
const BUILTIN = { claude, codex };
export function getAdapter(name, agents) {
    if (agents[name]?.command)
        return custom(name, agents[name]);
    const a = BUILTIN[name];
    if (!a) {
        const known = [...new Set([...Object.keys(BUILTIN), ...Object.keys(agents).filter((k) => agents[k].command)])];
        throw new Error(`unknown agent "${name}". Known: ${known.join(", ")}`);
    }
    return a;
}
export function knownAgents(agents) {
    return [...new Set([...Object.keys(BUILTIN), ...Object.keys(agents).filter((k) => agents[k].command)])];
}
