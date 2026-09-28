import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir } from "./config.js";
/** The agent skill shipped with the package (also installable with `npx skills add anup-a/grok-bot-bridge`). */
export const SKILL_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "grok-bots", "SKILL.md");
export const claudeSkillPath = () => path.join(os.homedir(), ".claude", "skills", "grok-bots", "SKILL.md");
export function hasClaudeCode() {
    return fs.existsSync(path.join(os.homedir(), ".claude"));
}
/** Install (or update) the skill for Claude Code. Returns the installed path. */
export function installClaudeSkill() {
    const dest = claudeSkillPath();
    ensureDir(path.dirname(dest), 0o755);
    fs.copyFileSync(SKILL_FILE, dest);
    return dest;
}
export const OTHER_AGENTS_HINT = "Other agents (Codex, Cursor, Gemini CLI and more): npx skills add anup-a/grok-bot-bridge";
