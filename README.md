# grok-bot-bridge

Two-way bridge between **Grok Bot** and the coding agents on your computer (Claude Code, Codex, or any CLI agent).

- **Talk to any of your Bots from the terminal or from an agent.** `gbb ask Health "How did I sleep?"` prints Health's answer. Claude Code can do the same with the included skill ("ask my Growth bot what to prioritize").
- **Your Bots → agents.** Grok Bot starts a local agent job (`gbb run claude "..."`), gets a job id right away, and is woken with the result when the job finishes. It can keep the conversation going in the same agent session (`gbb reply`).
- **Agents → your Bot.** Agents message your Bots through a webhook routine: job results and notes.

```
  Health   Growth   Investing ...          your other Bots
      ▲       ▲        ▲
      └───────┼────────┘  Bot-to-Bot messages (built into Grok Bot)
              │
           Bridge  ◀── webhook routine: ask, note, job_done ──┐
              │                                                        │
              └── runs gbb on your computer: answer, run, reply ──▶  gbb  ──▶ Claude Code, Codex, CLIs
```

You connect **one** dedicated Bot, "Bridge", and every other Bot becomes reachable through it. Grok Bot already lets Bots message each other, and a Bot with computer access can run `gbb`. So Bridge relays in both directions, and nothing else needs setting up per Bot.

> Unofficial community project. Not affiliated with or endorsed by xAI, Anysphere, Anthropic or OpenAI.

## Why

Grok Bot is good at planning, writing and follow-through. Local agents are good at changing code. Without a bridge, the Bot has to babysit a shell command until it times out, and the agent has no way to say "done, here's what I shipped." With the bridge:

- Long agent jobs run in the background. They can't be killed by a command timeout, and the Bot hears back when they finish.
- The Bot can have a real back-and-forth with the agent (same session, full context).
- Agents can leave notes for the Bot. The Bot only bothers you when something needs you.

## Requirements

- Node.js 20+
- The Grok Bot desktop app, with a Bot that can use your computer (for the Bot → agent direction)
- At least one agent CLI: [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`), [Codex](https://github.com/openai/codex) (`codex`), or any CLI you configure

## Install

```sh
npm install -g github:anup-a/grok-bot-bridge
gbb setup
```

Or from a clone: `git clone https://github.com/anup-a/grok-bot-bridge && cd grok-bot-bridge && npm install && npm link`.

`gbb setup` walks you through it:

1. In Grok Bot, click **+**, then **Create new Bot**. Send the new Bot the message gbb prints (it's also copied to your clipboard on macOS). The Bot renames itself **Bridge**, creates a routine named **Local agent bridge** with a webhook trigger, checks it can run `gbb` on your computer, and checks it can reach another Bot.
2. Open the routine's panel (click the "Created routine" chip in the chat) and copy the **Webhook URL** and **key**. Paste them into `gbb setup`.
3. gbb sends a test ping.

Then try it:

```sh
gbb ask Health "How did I sleep last night?"
gbb install skill      # optional: lets Claude Code talk to your Bots too
```

Non-interactive: `gbb setup --bot bridge --hub --url https://... --key ...`. To connect a Bot directly (its own routine, no hub), run `gbb setup --bot growth` and use `--bot growth`.

Credentials are stored in the macOS Keychain (service `grok-bot-bridge`). On other systems they go to `~/.grok-bot-bridge/credentials.json` with `0600` permissions. You can also use `GBB_WEBHOOK_URL` and `GBB_WEBHOOK_KEY`.

## Talk to any Bot

```sh
gbb ask Growth "What's the one thing I should ship this week?"   # waits for the answer (default 180s)
gbb ask Investing "Anything I need to act on today?" --wait 0    # don't wait; read it later
gbb inbox                                                        # recent questions and answers
gbb tell Health "Logged a 30 minute walk"                        # one-way message
```

How it works: gbb sends an `ask` event to Bridge with a message id. Bridge asks the Bot named in `to`, then runs `gbb answer <id>` on your computer to deliver the reply, and `gbb ask` prints it. A round trip usually takes 30 to 90 seconds.

**Claude Code:** `gbb install skill` adds a `grok-bots` skill, so "ask my Health bot how I slept" works inside Claude Code.

## Bot → agents

Your Bot runs these on your computer:

```sh
gbb run claude "Fix the flaky login test and open a PR" --cwd ~/code/app
# {"job_id": "jmujpg0qjfc1d", "agent": "claude", "status": "queued", ...}

gbb reply jmujpg0qjfc1d "Also add a regression test"   # same agent session, full context
gbb status jmujpg0qjfc1d                                # JSON status
gbb result jmujpg0qjfc1d                                # the agent's final answer
gbb wait jmujpg0qjfc1d --timeout 60                     # block if you really need to
gbb cancel jmujpg0qjfc1d
gbb list
```

When a job finishes, the Bot's routine fires with a `job_done` or `job_failed` event that carries the agent's final answer and the follow-up commands. Add `--for <Bot>` and Bridge forwards the result to that Bot.

Pass extra flags to the agent after `--`:

```sh
gbb run claude "Refactor utils" --cwd ~/code/app -- --permission-mode acceptEdits
gbb run codex "Update the README" -- --sandbox workspace-write
```

Headless agents use the permission settings you already have (`~/.claude/settings.json`, `~/.codex/config.toml`). Decide what a job may do without asking, and set per-agent defaults in the config (see below).

## Agents → Bot

```sh
gbb notify "Deployed the pricing page, needs a copy review" --file ./pricing.md
gbb ping
```

## Payload

Every webhook request is `POST` with `Authorization: Bearer <key>` and a JSON body:

```json
{
  "source": "grok-bot-bridge",
  "version": "0.1.0",
  "event": "job_done",
  "agent": "claude",
  "job_id": "jmujpg0qjfc1d",
  "session_id": "f10fc107-...",
  "cwd": "/Users/me/code/app",
  "summary": "Fixed the flaky test by ...",
  "next": ["gbb reply jmujpg0qjfc1d \"<follow-up message>\"", "gbb result jmujpg0qjfc1d"],
  "text": "[grok-bot-bridge] job_done from claude (job jmujpg0qjfc1d) ...",
  "host": "my-mac",
  "ts": "2026-09-27T10:58:00.000Z"
}
```

Events: `ask` (with `to` and `message_id`), `note` (optionally with `to`), `job_done`, `job_failed` (with `reply_to` when started with `--for`), `ping`. `text` is a human-readable version of the same data.

## Configuration

`~/.grok-bot-bridge/config.json` (`gbb config` prints it):

```json
{
  "defaultBot": "growth",
  "allowedRoots": ["~/code"],
  "maxPerHour": 12,
  "maxSummaryChars": 6000,
  "agents": {
    "claude": { "args": ["--permission-mode", "acceptEdits"] },
    "aider": { "command": ["aider", "--yes", "--message", "{prompt}"] }
  }
}
```

| Key | Meaning |
| --- | --- |
| `hubBot` | The connected Bot that relays `ask`/`tell` to other Bots. Set by `gbb setup --hub`. |
| `allowedRoots` | `gbb run` refuses working directories outside these roots. Unset means any directory. |
| `maxPerHour` | Webhook sends allowed per bot per rolling hour. This guards against loops. |
| `agents.<name>.args` | Extra args for built-in agents on every run. |
| `agents.<name>.command` | Adds a custom agent. `{prompt}` is replaced by the task, otherwise the task goes to stdin. Custom agents can't be resumed. |

Several bots: run `gbb setup --bot NAME` for each one, then use `--bot NAME` on any command.

Environment: `GBB_HOME` (state directory), `GBB_SILENT=1` (send nothing), `GBB_NO_KEYCHAIN=1`.

Jobs live in `~/.grok-bot-bridge/jobs/<id>/` (`job.json`, `stdout.log`, `stderr.log`, `result.txt`). The send log is `~/.grok-bot-bridge/notify.log`.

## Security

- **Anyone with the webhook key can wake your Bot.** Treat it like a password. gbb never writes it to logs.
- **`gbb run` executes agents with your user's permissions.** It gives your Bot no access it didn't already have through computer use, but it makes agent runs easy. Set `allowedRoots` and keep agent permission modes conservative.
- **Loops.** The routine message tells the Bot not to start new jobs in reaction to results unless you asked. gbb also rate-limits sends. `GBB_SILENT=1` turns sending off entirely.
- The routine message also tells the Bot never to post, email, DM, publish or spend from a routine run without asking you.

## FAQ

**Why a dedicated Bridge Bot?** A routine belongs to one Bot, and creating one means chatting with that Bot and copying a URL and key. With a hub you do that once. A dedicated Bot also keeps relay traffic out of your other chats and gives the bridge its own permissions. Chief of Staff can play the same role if you prefer.

**Why a CLI and not an MCP server?** Grok Bot runs local (stdio) MCP servers on its own cloud machine, not on your computer, so an MCP server there can't start your local agents. The Bot already reaches your computer through its computer-use tool, and the CLI works through that today.

**Does my computer need to be reachable from the internet?** No. Traffic out is a plain HTTPS POST to the webhook. Traffic in comes through the Grok Bot app you already run.

**Can I use this without Grok Bot?** The agent side is just "POST JSON with a bearer token", so any webhook receiver works.

## Development

```sh
npm install
npm test        # builds, then runs node:test against a local fake webhook and fake agents
```

`dist/` is committed so `npm install -g github:anup-a/grok-bot-bridge` works without a build step. Run `npm run build` and commit `dist/` with source changes.

## License

MIT
