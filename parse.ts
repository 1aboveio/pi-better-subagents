/**
 * Parse a child run's `--mode json` NDJSON log into clean, human-facing text.
 *
 * The child streams one JSON event per line (message lifecycle + token deltas).
 * Non-JSON lines — pi's `[pi-warp] …` banner, `Warning: No project session …`,
 * any stray stderr — simply fail to parse and are skipped, so the noise that
 * polluted `--mode text` output never reaches the caller.
 */

import { readFileSync } from "node:fs";
import { logPathFor } from "./registry.ts";

interface ContentBlock { type: string; text?: string; name?: string }
interface Cost { total?: number }
interface MsgUsage { input?: number; output?: number; cacheRead?: number; cost?: Cost }
interface Msg { role?: string; content?: string | ContentBlock[]; usage?: MsgUsage }

/** Cumulative token + cost spend across a run's turns. */
export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    costUSD: number;
    /** input + output, the headline "tokens" number. */
    total: number;
}

/** Join the text blocks of a message into a plain string. */
function messageText(msg: Msg | undefined): string {
    if (!msg) return "";
    const c = msg.content;
    if (typeof c === "string") return c;
    if (!Array.isArray(c)) return "";
    return c.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("").trim();
}

export interface ParsedRun {
    /** Final assistant answer (empty until the run produces one). */
    finalText: string;
    /** Latest streamed text/thinking, for a live progress peek. */
    lastActivity: string;
    /** Names of tools the child invoked, in order (deduped-adjacent). */
    toolCalls: string[];
    /** True if we saw the terminal `agent_end`/`agent_settled` event. */
    sawEnd: boolean;
    /** Cumulative token + cost spend so far. */
    usage: Usage;
}

/** Parse the log for run `id`. Tolerant of partial/streaming logs. */
export function parseRun(id: string): ParsedRun {
    let body: string;
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, costUSD: 0, total: 0 };
    try {
        body = readFileSync(logPathFor(id), "utf-8");
    } catch {
        return { finalText: "", lastActivity: "", toolCalls: [], sawEnd: false, usage };
    }

    let finalText = "";
    let lastActivity = "";
    const toolCalls: string[] = [];
    let sawEnd = false;

    for (const line of body.split("\n")) {
        const s = line.trim();
        if (!s || s[0] !== "{") continue; // skip banners / warnings / blanks
        let e: Record<string, unknown>;
        try { e = JSON.parse(s); } catch { continue; }

        const type = e.type as string | undefined;

        // Authoritative final answer: the last assistant message at run end.
        if (type === "agent_end" && Array.isArray(e.messages)) {
            for (let i = e.messages.length - 1; i >= 0; i--) {
                const m = e.messages[i] as Msg;
                if (m?.role === "assistant") { const t = messageText(m); if (t) finalText = t; break; }
            }
            sawEnd = true;
        }
        if (type === "agent_settled") sawEnd = true;

        // Progress signal + fallback final: finalized assistant turns.
        // Accumulate spend from `message_end` only (fires once per turn), so
        // multi-turn tool-using runs sum correctly without double counting.
        if (type === "message_end") {
            const m = e.message as Msg | undefined;
            if (m?.role === "assistant") {
                const t = messageText(m);
                // Latest finalized assistant text wins, so a run without a
                // terminal `agent_end` still yields its LAST answer, not its first.
                if (t) { lastActivity = t; finalText = t; }
                const u = m?.usage;
                if (u) {
                    usage.input += u.input ?? 0;
                    usage.output += u.output ?? 0;
                    usage.cacheRead += u.cacheRead ?? 0;
                    usage.costUSD += u.cost?.total ?? 0;
                }
            }
        }
        if (type === "turn_end") {
            const m = e.message as Msg | undefined;
            if (m?.role === "assistant") {
                const t = messageText(m);
                if (t) { lastActivity = t; if (!finalText) finalText = t; }
            }
        }

        // Live streaming: latest partial text or thinking.
        if (type === "message_update") {
            const m = e.message as Msg | undefined;
            const t = messageText(m);
            if (t) lastActivity = t;
            else if (Array.isArray(m?.content)) {
                const think = m!.content.find((b) => b?.type === "thinking") as { thinking?: string } | undefined;
                if (think?.thinking) lastActivity = `(thinking) ${think.thinking}`;
            }
        }

        // Tool activity.
        if (type === "tool_execution_start" && typeof e.toolName === "string") {
            if (toolCalls[toolCalls.length - 1] !== e.toolName) toolCalls.push(e.toolName);
        }
    }

    usage.total = usage.input + usage.output;
    return { finalText, lastActivity, toolCalls, sawEnd, usage };
}
