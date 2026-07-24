/**
 * Extension config — a single `config.json` next to this file sets defaults for
 * every subagent, each overridable per `subagent_spawn` call.
 *
 *   { "defaultModel": "xai/grok-4.5", "defaultTools": "read, bash, web_fetch" }
 *
 * `defaultModel: null` / absent → inherit the foreground model.
 * `defaultTools` absent → the built-in SAFE_DEFAULT_TOOLS.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface SubagentConfig {
    defaultModel?: string | null;
    defaultTools?: string | null;
}

/** Built-in default tool set when config.json sets nothing. */
export const SAFE_DEFAULT_TOOLS = "read, bash, edit, write, web_search, web_fetch";
/** Safe default for a hermetic (clean) child where extension tools don't exist. */
export const SAFE_CLEAN_TOOLS = "read, bash";

let cached: SubagentConfig | undefined;

/** Load config.json from the extension directory. Missing/invalid → {}. */
export function loadConfig(): SubagentConfig {
    if (cached) return cached;
    try {
        const dir = dirname(fileURLToPath(import.meta.url));
        cached = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")) as SubagentConfig;
    } catch {
        cached = {};
    }
    return cached;
}

/** Normalize a comma/space tool list to pi's bare comma form: "a, b" → "a,b". */
export function normalizeTools(list: string): string {
    return list.split(",").map((t) => t.trim()).filter(Boolean).join(",");
}
