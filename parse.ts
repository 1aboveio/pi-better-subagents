/**
 * Parse a child run's `--mode json` NDJSON log into clean, human-facing text.
 *
 * The child streams one JSON event per line (message lifecycle + token deltas).
 * Non-JSON lines — pi's `[pi-warp] …` banner, `Warning: No project session …`,
 * any stray stderr — simply fail to parse and are skipped, so the noise that
 * polluted `--mode text` output never reaches the caller.
 *
 * Large logs: reading the whole file can exceed Node's max string length
 * (~536 MB) and makes live output expensive. parseRun() therefore reads only a
 * bounded tail; final answers live at the end of completed logs, and recent
 * activity is what a live caller needs.
 */

import {
    closeSync,
    openSync,
    readFileSync,
    readSync,
    statSync,
} from "node:fs";
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

const DEFAULT_PARSE_TAIL_BYTES = 32 * 1024 * 1024; // 32 MiB
const DEFAULT_RAW_TAIL_BYTES = 256 * 1024; // 256 KiB
const COHERENCE_SCAN_CHUNK_BYTES = 64 * 1024; // 64 KiB
const MAX_COHERENCE_EVENT_PREFIX_BYTES = 64 * 1024; // 64 KiB

function envBytes(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function maxParseBytes(): number {
    return envBytes("PI_SUBAGENT_MAX_LOG_PARSE_BYTES", DEFAULT_PARSE_TAIL_BYTES);
}

function maxRawTailBytes(): number {
    return envBytes("PI_SUBAGENT_MAX_RAW_TAIL_BYTES", DEFAULT_RAW_TAIL_BYTES);
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB"];
    let i = 0;
    let size = n / 1024;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    return `${size.toFixed(1)} ${units[i]}`;
}

interface TailRead {
    text: string;
    truncated: boolean;
    totalBytes: number;
    /** Set when the file could not be opened/read; text is empty. */
    error?: string;
}

/**
 * Read at most `maxBytes` from the end of `path`. Avoids `readFileSync` so logs
 * larger than Node's max string length can still be tailed for live output.
 */
function readTail(path: string, maxBytes: number): TailRead {
    let totalBytes = 0;
    try {
        totalBytes = statSync(path).size;
    } catch {
        return { text: "", truncated: false, totalBytes: 0, error: "log not found" };
    }

    if (totalBytes === 0) {
        return { text: "", truncated: false, totalBytes: 0 };
    }

    if (totalBytes <= maxBytes) {
        try {
            return { text: readFileSync(path, "utf-8"), truncated: false, totalBytes };
        } catch (e) {
            return {
                text: "",
                truncated: false,
                totalBytes,
                error: `read failed: ${(e as Error).message}`,
            };
        }
    }

    let fd: number;
    try {
        fd = openSync(path, "r");
    } catch (e) {
        return {
            text: "",
            truncated: true,
            totalBytes,
            error: `open failed: ${(e as Error).message}`,
        };
    }

    const buf = Buffer.alloc(maxBytes);
    const offset = totalBytes - maxBytes;
    let read = 0;
    try {
        read = readSync(fd, buf, 0, maxBytes, offset);
    } catch (e) {
        closeSync(fd);
        return {
            text: "",
            truncated: true,
            totalBytes,
            error: `tail read failed: ${(e as Error).message}`,
        };
    }
    closeSync(fd);

    const text = buf.toString("utf-8", 0, read);

    return { text, truncated: true, totalBytes };
}

/** Last `n` lines of a run's log, or a placeholder if empty/unreadable. */
export function tailLog(id: string, n: number, maxBytes = maxRawTailBytes()): string {
    const tail = readTail(logPathFor(id), maxBytes);
    if (tail.error || tail.text.trim() === "") return "(no output yet)";
    const lines = tail.text.split("\n");
    const kept = lines.slice(Math.max(0, lines.length - n));
    const out = kept.join("\n").trim();
    return out === "" ? "(no output yet)" : out;
}

/** Join the text blocks of a message into a plain string. */
function messageText(msg: Msg | undefined): string {
    if (!msg) return "";
    const c = msg.content;
    if (typeof c === "string") return c;
    if (!Array.isArray(c)) return "";
    return c.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("").trim();
}

export interface UnmatchedToolCall {
    /** Child tool-call id when the event stream provides one. */
    id?: string;
    /** Child tool name, retained for human diagnostics. */
    toolName: string;
}

interface StreamCoherence {
    sawEnd: boolean;
    unmatchedToolCalls: UnmatchedToolCall[];
    error?: string;
}

interface MutableStreamCoherence {
    sawEnd: boolean;
    openToolCalls: Map<string, UnmatchedToolCall>;
    anonymousToolCall: number;
}

function stringField(event: Record<string, unknown>, field: string): string | undefined {
    return typeof event[field] === "string" ? event[field] : undefined;
}

function trackCoherenceEvent(event: Record<string, unknown>, coherence: MutableStreamCoherence): void {
    const type = stringField(event, "type");
    if (type === "agent_end" || type === "agent_settled") coherence.sawEnd = true;

    const toolCallId = stringField(event, "toolCallId");
    if (type === "tool_execution_start") {
        const toolName = stringField(event, "toolName") ?? "unknown";
        coherence.openToolCalls.set(
            toolCallId ?? `anonymous:${coherence.anonymousToolCall++}`,
            { id: toolCallId, toolName },
        );
    }
    if (type === "tool_execution_end") {
        if (toolCallId) {
            coherence.openToolCalls.delete(toolCallId);
        } else {
            const toolName = stringField(event, "toolName");
            if (toolName) {
                const matching = [...coherence.openToolCalls].find(([, call]) => call.toolName === toolName);
                if (matching) coherence.openToolCalls.delete(matching[0]);
            }
        }
    }
}

/** Extract known event metadata from a bounded prefix of an oversized NDJSON record. */
function jsonStringField(line: string, field: string): string | undefined {
    const match = line.match(new RegExp(`"${field}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`));
    if (!match) return undefined;
    try { return JSON.parse(match[1]); } catch { return undefined; }
}

function parseCoherenceEvent(line: string, truncated: boolean): Record<string, unknown> | undefined {
    const text = line.trim();
    if (!text || text[0] !== "{") return undefined;
    if (!truncated) {
        try { return JSON.parse(text); } catch { return undefined; }
    }

    // Pi writes event metadata at the start of each record. For an oversized
    // payload, retain only that bounded metadata rather than rebuilding output.
    const type = jsonStringField(text, "type");
    if (!type) return undefined;
    return {
        type,
        toolCallId: jsonStringField(text, "toolCallId"),
        toolName: jsonStringField(text, "toolName"),
    };
}

/**
 * Scan every NDJSON record for terminal and tool-execution coherence without
 * retaining assistant content. Record prefixes and read buffers are bounded.
 */
function scanStreamCoherence(path: string): StreamCoherence {
    const coherence: MutableStreamCoherence = {
        sawEnd: false,
        openToolCalls: new Map<string, UnmatchedToolCall>(),
        anonymousToolCall: 0,
    };
    let fd: number;
    try {
        fd = openSync(path, "r");
    } catch (e) {
        return { sawEnd: false, unmatchedToolCalls: [], error: `open failed: ${(e as Error).message}` };
    }

    const buffer = Buffer.alloc(COHERENCE_SCAN_CHUNK_BYTES);
    let lineParts: Buffer[] = [];
    let lineBytes = 0;
    let lineTruncated = false;
    const appendLineBytes = (bytes: Buffer): void => {
        if (lineTruncated || bytes.length === 0) return;
        const remaining = MAX_COHERENCE_EVENT_PREFIX_BYTES - lineBytes;
        if (remaining <= 0) {
            lineTruncated = true;
            return;
        }
        const kept = bytes.subarray(0, remaining);
        lineParts.push(kept);
        lineBytes += kept.length;
        if (kept.length < bytes.length) lineTruncated = true;
    };
    const finishLine = (): void => {
        if (lineBytes > 0 || lineTruncated) {
            const event = parseCoherenceEvent(Buffer.concat(lineParts).toString("utf-8"), lineTruncated);
            if (event) trackCoherenceEvent(event, coherence);
        }
        lineParts = [];
        lineBytes = 0;
        lineTruncated = false;
    };

    try {
        while (true) {
            const count = readSync(fd, buffer, 0, buffer.length, null);
            if (count === 0) break;
            let start = 0;
            for (let i = 0; i < count; i++) {
                if (buffer[i] !== 0x0a) continue;
                appendLineBytes(buffer.subarray(start, i));
                finishLine();
                start = i + 1;
            }
            appendLineBytes(buffer.subarray(start, count));
        }
        finishLine();
    } catch (e) {
        return {
            sawEnd: false,
            unmatchedToolCalls: [],
            error: `read failed: ${(e as Error).message}`,
        };
    } finally {
        closeSync(fd);
    }

    return { sawEnd: coherence.sawEnd, unmatchedToolCalls: [...coherence.openToolCalls.values()] };
}

export interface ParsedRun {
    /** Final assistant answer (empty until the run produces one). */
    finalText: string;
    /** Latest streamed text/thinking, for a live progress peek. */
    lastActivity: string;
    /** Names of tools the child invoked, in order (deduped-adjacent). */
    toolCalls: string[];
    /** Tool starts that were not matched by a tool end before parsing stopped. */
    unmatchedToolCalls: UnmatchedToolCall[];
    /** True if we saw the terminal `agent_end`/`agent_settled` event. */
    sawEnd: boolean;
    /** Cumulative token + cost spend so far. */
    usage: Usage;
    /** Diagnostics about truncation or parse failure, surfaced to the user. */
    diagnostics: string[];
}

/** Parse the log for run `id`. Tolerant of partial/streaming logs. */
export function parseRun(id: string): ParsedRun {
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, total: 0, costUSD: 0 };
    const path = logPathFor(id);
    const tail = readTail(path, maxParseBytes());
    const coherence = scanStreamCoherence(path);
    const diagnostics: string[] = [];

    // For NDJSON parsing we need complete lines; drop an initial partial line
    // that was split by the byte-boundary read. The raw-tail fallback (tailLog)
    // keeps those bytes so large single-line events are still visible to users.
    let parseText = tail.text;
    if (tail.truncated) {
        const firstNewline = parseText.indexOf("\n");
        if (firstNewline !== -1) {
            parseText = parseText.slice(firstNewline + 1);
        }
    }

    if (tail.error) {
        diagnostics.push(`Log unreadable: ${tail.error}`);
        return { finalText: "", lastActivity: "", toolCalls: [], unmatchedToolCalls: [], sawEnd: false, usage, diagnostics };
    }
    if (tail.totalBytes === 0) {
        return { finalText: "", lastActivity: "", toolCalls: [], unmatchedToolCalls: [], sawEnd: false, usage, diagnostics };
    }
    if (tail.truncated) {
        diagnostics.push(
            `Log truncated: parsed last ${fmtBytes(maxParseBytes())} of ${fmtBytes(tail.totalBytes)}. ` +
            "Only recent activity is reflected in tokens/tools.",
        );
    }
    if (coherence.error) diagnostics.push(`Event coherence scan unreadable: ${coherence.error}`);

    let finalText = "";
    let lastActivity = "";
    const toolCalls: string[] = [];

    for (const line of parseText.split("\n")) {
        const s = line.trim();
        if (!s || s[0] !== "{") continue; // skip banners / warnings / blanks
        let e: Record<string, unknown>;
        try { e = JSON.parse(s); } catch { continue; }

        const type = e.type as string | undefined;

        // Authoritative final answer: the last assistant message at run end.
        if (type === "agent_end") {
            if (Array.isArray(e.messages)) {
                for (let i = e.messages.length - 1; i >= 0; i--) {
                    const m = e.messages[i] as Msg;
                    if (m?.role === "assistant") { const t = messageText(m); if (t) finalText = t; break; }
                }
            }
        }

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

        // Tool activity. Pi emits a toolCallId for normal events; fall back to
        // tool-name matching when replaying older/id-less streams.
        const toolCallId = typeof e.toolCallId === "string" ? e.toolCallId : undefined;
        if (type === "tool_execution_start") {
            const toolName = typeof e.toolName === "string" ? e.toolName : "unknown";
            if (toolCalls[toolCalls.length - 1] !== toolName) toolCalls.push(toolName);
        }
    }

    if (!finalText && !lastActivity && toolCalls.length === 0) {
        diagnostics.push("No parseable assistant/tool events found in the log tail.");
    }

    usage.total = usage.input + usage.output;
    return {
        finalText,
        lastActivity,
        toolCalls,
        unmatchedToolCalls: coherence.unmatchedToolCalls,
        sawEnd: coherence.sawEnd,
        usage,
        diagnostics,
    };
}
/** Build the human-readable body for subagent_output. Exported for unit testing. */
export function formatSubagentOutputBody(
    head: string,
    tools: string,
    parsedBody: string | undefined,
    rawTail: string,
    diagnostics: string[],
): string {
    let body: string;
    if (parsedBody) {
        body = parsedBody;
    } else {
        body = rawTail === "(no output yet)"
            ? "(no output yet)"
            : `(no parsed output yet)\n\n--- raw log tail ---\n${rawTail}`;
    }
    const diag = diagnostics.length ? `\n[parser: ${diagnostics.join("; ")}]` : "";
    return `${head}${tools}${diag}\n${body}`;
}

/** Build the human-readable body for subagent_result. Exported for unit testing. */
export function formatSubagentResultBody(
    head: string,
    finalText: string | undefined,
    rawTail: string,
    diagnostics: string[],
): string {
    let body = finalText || `(no final answer parsed)\n\n--- raw log tail ---\n${rawTail}`;
    const diag = diagnostics.length ? `\n[parser: ${diagnostics.join("; ")}]` : "";
    return `${head}${diag}\n${body}`;
}
