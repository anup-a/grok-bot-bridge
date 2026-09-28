---
name: grok-bots
description: "Talk to the user's Grok Bot bots (Health, Growth, Investing, Chief of Staff and so on) from the terminal with the gbb CLI. Ask a bot a question and get its answer, send a bot a message, or check replies. Use when the user says ask my X bot, tell X something, check with X, or when a task needs information one of their Grok Bots has."
---

# Talking to Grok Bots with gbb

`gbb` (npm package `grok-bot-bridge`) connects this machine with the user's Grok Bots. It reaches every Bot through one hub Bot, usually named "Bridge".

## Check it's set up

Run `gbb doctor`. If `gbb` is missing, install it with `npm install -g grok-bot-bridge`. If no bots are configured, the user needs to run `gbb setup` once. It involves a step in the Grok Bot app, so ask them to do it rather than trying yourself.

## Ask, tell, read

- Ask and wait for the answer (usually 30 to 90 seconds; give the command a timeout of at least 5 minutes):
  `gbb ask <Bot> "<question>" --wait 240`
  The answer is printed on stdout. Exit code 2 means no answer yet; read it later with `gbb inbox <message_id>`.
- Send a message without waiting: `gbb tell <Bot> "<message>"`
- Recent questions and answers: `gbb inbox`
- Not sure which Bots exist? `gbb ask Bridge "List my Bots and what each one does"`

Write self-contained questions: the Bot can't see this conversation. Include the context it needs and say what form the answer should take.

## The other direction

The user's Bots can start agent jobs on this machine with `gbb run claude|codex "<task>"` and get the result back through a webhook. You don't need to do anything for that; it runs as a separate session. If you are running as such a job, just do the task and end with a clear final answer.

## Rules

Never ask a Bot to post, email, DM, publish or spend on the user's behalf unless the user explicitly asked for that. Don't paste webhook URLs or keys anywhere.
