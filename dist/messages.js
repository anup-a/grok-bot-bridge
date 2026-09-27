import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, homeDir, readJson, writeJsonAtomic } from "./config.js";
const dir = () => ensureDir(path.join(homeDir(), "messages"));
const file = (id) => path.join(dir(), `${id}.json`);
export function newMessage(to, question, hub) {
    const msg = {
        id: `m${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`,
        to,
        question,
        hub,
        askedAt: new Date().toISOString(),
    };
    writeJsonAtomic(file(msg.id), msg);
    return msg;
}
export function loadMessage(id) {
    const m = readJson(file(id), null);
    if (!m)
        throw new Error(`no such message: ${id}`);
    return m;
}
export function answerMessage(id, answer) {
    const m = loadMessage(id);
    const updated = { ...m, answer: answer.trim(), answeredAt: new Date().toISOString() };
    writeJsonAtomic(file(id), updated);
    return updated;
}
export async function waitForAnswer(id, timeoutSec) {
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
        const m = loadMessage(id);
        if (m.answer !== undefined || Date.now() >= deadline)
            return m;
        await new Promise((r) => setTimeout(r, 1000));
    }
}
export function listMessages(limit = 20) {
    return fs
        .readdirSync(dir())
        .filter((f) => f.endsWith(".json"))
        .map((f) => readJson(path.join(dir(), f), null))
        .filter((m) => m !== null)
        .sort((a, b) => b.askedAt.localeCompare(a.askedAt))
        .slice(0, limit);
}
