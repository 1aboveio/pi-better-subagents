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

/**
 * Authoritative lifecycle evidence scanned from the complete NDJSON stream.
 * Kept separate from parseRun()'s bounded tail so large-log result parsing stays
 * memory-safe while clean completion still requires full-stream tool balance.
 */
export interface LifecycleEvidence {
    sawEnd: boolean;
    unmatchedToolCalls: UnmatchedToolCall[];
    /** True when the full file was readable end-to-end. */
    complete: boolean;
    diagnostics: string[];
}

/** Fixed read size for lifecycle authority scans. Exported for memory-bound tests. */
export const LIFECYCLE_SCAN_CHUNK_BYTES = 64 * 1024;
/**
 * Historical per-record prefix bound used by fixtures/tests. The structural
 * scanner no longer retains a record prefix; it streams with O(1) state and
 * only keeps top-level lifecycle field values after structural validity.
 */
export const LIFECYCLE_RECORD_PREFIX_BYTES = 4 * 1024;

/** Bound captured top-level lifecycle string values (type / toolCallId / toolName). */
const LIFECYCLE_FIELD_VALUE_MAX_CHARS = 1024;
const LIFECYCLE_FIELD_KEY_MAX_CHARS = 64;
const LIFECYCLE_TOP_LEVEL_KEYS = new Set(["type", "toolCallId", "toolName"]);

function emptyLifecycleEvidence(diagnostics: string[] = []): LifecycleEvidence {
    return { sawEnd: false, unmatchedToolCalls: [], complete: false, diagnostics };
}

function applyLifecycleFields(
    fields: { type?: string; toolCallId?: string; toolName?: string },
    openToolCalls: Map<string, UnmatchedToolCall>,
    state: { sawEnd: boolean; anonymousToolCall: number },
): void {
    const type = fields.type;
    if (!type) return;
    if (type === "agent_end" || type === "agent_settled") state.sawEnd = true;

    const toolCallId = fields.toolCallId;
    if (type === "tool_execution_start") {
        const toolName = fields.toolName ?? "unknown";
        openToolCalls.set(toolCallId ?? `anonymous:${state.anonymousToolCall++}`, {
            id: toolCallId,
            toolName,
        });
    }
    if (type === "tool_execution_end") {
        if (toolCallId) {
            openToolCalls.delete(toolCallId);
        } else if (fields.toolName) {
            const matching = [...openToolCalls].find(([, call]) => call.toolName === fields.toolName);
            if (matching) openToolCalls.delete(matching[0]);
        }
    }
}

function unescapeJsonStringContent(raw: string): string {
    try {
        return JSON.parse(`"${raw}"`) as string;
    } catch {
        return raw;
    }
}

/**
 * Bounded structural NDJSON object scanner.
 * Tracks JSON nesting and top-level keys without retaining payloads. Lifecycle
 * fields are collected only for depth-1 keys and may be applied only after the
 * record returns to depth 0 (structurally valid).
 */
interface StructuralRecordScan {
    depth: number;
    inString: boolean;
    escape: boolean;
    /** True while consuming a non-string primitive (number/true/false/null). */
    inPrimitive: boolean;
    /** Top-level object parse expectation when depth === 1 and not in a string. */
    expect: "key" | "colon" | "value" | "comma";
    started: boolean;
    finished: boolean;
    malformed: boolean;
    skipLine: boolean;
    currentKey: string | null;
    capturingKey: boolean;
    keyBuf: string;
    capturingValue: boolean;
    valueBuf: string;
    type?: string;
    toolCallId?: string;
    toolName?: string;
}

function createStructuralRecordScan(): StructuralRecordScan {
    return {
        depth: 0,
        inString: false,
        escape: false,
        inPrimitive: false,
        expect: "key",
        started: false,
        finished: false,
        malformed: false,
        skipLine: false,
        currentKey: null,
        capturingKey: false,
        keyBuf: "",
        capturingValue: false,
        valueBuf: "",
    };
}

function assignTopLevelLifecycleValue(scan: StructuralRecordScan): void {
    const key = scan.currentKey;
    if (!key || !LIFECYCLE_TOP_LEVEL_KEYS.has(key)) return;
    const value = unescapeJsonStringContent(scan.valueBuf);
    if (key === "type") scan.type = value;
    else if (key === "toolCallId") scan.toolCallId = value;
    else if (key === "toolName") scan.toolName = value;
}

function feedStructuralRecordChar(scan: StructuralRecordScan, ch: string): void {
    if (scan.malformed || scan.finished || scan.skipLine) return;

    if (scan.inString) {
        if (scan.escape) {
            if (scan.capturingKey && scan.keyBuf.length < LIFECYCLE_FIELD_KEY_MAX_CHARS) {
                scan.keyBuf += `\\${ch}`;
            } else if (scan.capturingValue && scan.valueBuf.length < LIFECYCLE_FIELD_VALUE_MAX_CHARS) {
                scan.valueBuf += `\\${ch}`;
            }
            scan.escape = false;
            return;
        }
        if (ch === "\\") {
            scan.escape = true;
            return;
        }
        if (ch === "\"") {
            scan.inString = false;
            if (scan.capturingKey) {
                scan.capturingKey = false;
                scan.currentKey = scan.keyBuf;
                scan.expect = "colon";
            } else if (scan.capturingValue) {
                scan.capturingValue = false;
                assignTopLevelLifecycleValue(scan);
                scan.expect = "comma";
                scan.currentKey = null;
            } else if (scan.depth === 1 && scan.expect === "value") {
                // Non-lifecycle top-level string value finished.
                scan.expect = "comma";
                scan.currentKey = null;
            }
            return;
        }
        if (scan.capturingKey && scan.keyBuf.length < LIFECYCLE_FIELD_KEY_MAX_CHARS) {
            scan.keyBuf += ch;
        } else if (scan.capturingValue && scan.valueBuf.length < LIFECYCLE_FIELD_VALUE_MAX_CHARS) {
            scan.valueBuf += ch;
        }
        return;
    }

    // Outside strings: ignore insignificant whitespace (newlines end records externally).
    if (ch === " " || ch === "\t" || ch === "\r") {
        if (scan.inPrimitive) {
            // Whitespace ends a primitive value.
            scan.inPrimitive = false;
            if (scan.depth === 1) {
                scan.expect = "comma";
                scan.currentKey = null;
            }
        }
        return;
    }

    if (scan.inPrimitive) {
        // Structural delimiters end the primitive; other chars continue it.
        if (ch === "," || ch === "}" || ch === "]" || ch === "{" || ch === "[" || ch === ":") {
            scan.inPrimitive = false;
            if (scan.depth === 1) {
                scan.expect = "comma";
                scan.currentKey = null;
            }
            // Fall through to handle the delimiter itself.
        } else {
            return;
        }
    }

    if (!scan.started) {
        if (ch === "{") {
            scan.started = true;
            scan.depth = 1;
            scan.expect = "key";
            return;
        }
        // Non-object NDJSON noise — ignore until the next record boundary.
        scan.skipLine = true;
        return;
    }

    if (ch === "\"") {
        if (scan.depth === 1 && scan.expect === "key") {
            scan.inString = true;
            scan.capturingKey = true;
            scan.keyBuf = "";
            return;
        }
        if (
            scan.depth === 1 &&
            scan.expect === "value" &&
            scan.currentKey !== null &&
            LIFECYCLE_TOP_LEVEL_KEYS.has(scan.currentKey)
        ) {
            scan.inString = true;
            scan.capturingValue = true;
            scan.valueBuf = "";
            return;
        }
        // Nested string or non-lifecycle top-level string: track bounds only.
        scan.inString = true;
        return;
    }

    if (ch === ":") {
        if (scan.depth === 1) {
            if (scan.expect !== "colon") {
                scan.malformed = true;
                return;
            }
            scan.expect = "value";
        }
        return;
    }

    if (ch === "{") {
        if (scan.depth === 1 && scan.expect !== "value" && scan.expect !== "key") {
            // Empty-object key position allows only } or "key"; nested object only as value.
            if (scan.expect !== "value") {
                scan.malformed = true;
                return;
            }
        }
        if (scan.depth === 1 && scan.expect === "key") {
            scan.malformed = true;
            return;
        }
        scan.depth++;
        return;
    }

    if (ch === "[") {
        if (scan.depth === 1 && scan.expect === "key") {
            scan.malformed = true;
            return;
        }
        scan.depth++;
        return;
    }

    if (ch === "}") {
        if (scan.depth <= 0) {
            scan.malformed = true;
            return;
        }
        scan.depth--;
        if (scan.depth === 0) {
            scan.finished = true;
            return;
        }
        if (scan.depth === 1) {
            // Closed a nested value at top level.
            scan.expect = "comma";
            scan.currentKey = null;
        }
        return;
    }

    if (ch === "]") {
        if (scan.depth <= 0) {
            scan.malformed = true;
            return;
        }
        scan.depth--;
        if (scan.depth === 1) {
            scan.expect = "comma";
            scan.currentKey = null;
        } else if (scan.depth === 0) {
            // Top-level arrays are not lifecycle objects.
            scan.malformed = true;
        }
        return;
    }

    if (ch === ",") {
        if (scan.depth === 1) {
            if (scan.expect !== "comma") {
                scan.malformed = true;
                return;
            }
            scan.expect = "key";
            scan.currentKey = null;
        }
        return;
    }

    // Primitive top-level/nested value (true/false/null/number): stream until delimiter.
    if (scan.depth === 1) {
        if (scan.expect !== "value") {
            scan.malformed = true;
            return;
        }
        scan.inPrimitive = true;
        return;
    }
    if (scan.depth > 1) {
        scan.inPrimitive = true;
        return;
    }

    scan.malformed = true;
}

/**
 * Stream the complete child log for lifecycle authority only.
 * Reads fixed-size chunks and walks each NDJSON record with bounded structural
 * state (no per-record payload retention). Top-level lifecycle fields are applied
 * only after a record is structurally valid; unfinished/malformed records fail closed.
 */
export function scanLifecycleEvidence(id: string): LifecycleEvidence {
    const path = logPathFor(id);
    let totalBytes = 0;
    try {
        totalBytes = statSync(path).size;
    } catch {
        return emptyLifecycleEvidence(["Lifecycle scan failed: log not found"]);
    }
    if (totalBytes === 0) {
        return { sawEnd: false, unmatchedToolCalls: [], complete: true, diagnostics: [] };
    }

    let fd: number;
    try {
        fd = openSync(path, "r");
    } catch (e) {
        return emptyLifecycleEvidence([`Lifecycle scan failed: open failed: ${(e as Error).message}`]);
    }

    const openToolCalls = new Map<string, UnmatchedToolCall>();
    const state = { sawEnd: false, anonymousToolCall: 0 };
    const diagnostics: string[] = [];
    const buf = Buffer.alloc(Math.min(LIFECYCLE_SCAN_CHUNK_BYTES, totalBytes));
    let offset = 0;
    let complete = true;
    let scan = createStructuralRecordScan();

    const markUntrusted = (msg: string): void => {
        complete = false;
        if (!diagnostics.includes(msg)) diagnostics.push(msg);
    };

    const finishRecord = (): void => {
        if (scan.skipLine || !scan.started) {
            scan = createStructuralRecordScan();
            return;
        }
        if (scan.malformed || scan.inString || scan.inPrimitive || scan.depth !== 0 || !scan.finished) {
            markUntrusted("Lifecycle scan found unfinished or malformed NDJSON record");
            scan = createStructuralRecordScan();
            return;
        }
        // Structurally valid object: apply only top-level lifecycle ownership.
        applyLifecycleFields(
            {
                type: scan.type,
                toolCallId: scan.toolCallId,
                toolName: scan.toolName,
            },
            openToolCalls,
            state,
        );
        scan = createStructuralRecordScan();
    };

    try {
        while (offset < totalBytes) {
            const toRead = Math.min(buf.length, totalBytes - offset);
            let read = 0;
            try {
                read = readSync(fd, buf, 0, toRead, offset);
            } catch (e) {
                return emptyLifecycleEvidence([
                    `Lifecycle scan failed: read failed: ${(e as Error).message}`,
                ]);
            }
            if (read <= 0) break;
            offset += read;

            // Decode chunk; structural state is O(1) so the chunk string is dropped each loop.
            const chunk = buf.toString("utf-8", 0, read);
            for (let i = 0; i < chunk.length; i++) {
                const ch = chunk[i];
                if (ch === "\n") {
                    finishRecord();
                    continue;
                }
                if (scan.finished) {
                    // Trailing junk after a closed object before newline is malformed.
                    if (ch !== " " && ch !== "\t" && ch !== "\r") {
                        scan.malformed = true;
                    }
                    continue;
                }
                if (scan.skipLine) continue;
                feedStructuralRecordChar(scan, ch);
            }
        }

        // EOF: finalize any record lacking a trailing newline.
        if (scan.started || scan.malformed) {
            finishRecord();
        } else if (scan.skipLine) {
            // Noise-only trailing content without a record — ignore.
        }
    } finally {
        closeSync(fd);
    }

    return {
        sawEnd: state.sawEnd,
        unmatchedToolCalls: [...openToolCalls.values()],
        complete,
        diagnostics,
    };
}

/** Overlay full-stream lifecycle fields onto a bounded parseRun result. */
export function withLifecycleEvidence(run: ParsedRun, evidence: LifecycleEvidence): ParsedRun {
    const diagnostics = [...run.diagnostics];
    for (const d of evidence.diagnostics) {
        if (!diagnostics.includes(d)) diagnostics.push(d);
    }
    // When the full stream could not be read, refuse clean completion by clearing
    // terminal evidence even if the bounded tail looked coherent.
    if (!evidence.complete) {
        return {
            ...run,
            sawEnd: false,
            unmatchedToolCalls: evidence.unmatchedToolCalls,
            diagnostics,
        };
    }
    return {
        ...run,
        sawEnd: evidence.sawEnd,
        unmatchedToolCalls: evidence.unmatchedToolCalls,
        diagnostics,
    };
}

/** Bounded output parse + authoritative full-stream lifecycle evidence. */
export function parseRunForLifecycle(id: string): ParsedRun {
    return withLifecycleEvidence(parseRun(id), scanLifecycleEvidence(id));
}

/** Parse the log for run `id`. Tolerant of partial/streaming logs. */
export function parseRun(id: string): ParsedRun {
    const usage: Usage = { input: 0, output: 0, cacheRead: 0, costUSD: 0, total: 0 };
    const tail = readTail(logPathFor(id), maxParseBytes());
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

    let finalText = "";
    let lastActivity = "";
    const toolCalls: string[] = [];
    const openToolCalls = new Map<string, UnmatchedToolCall>();
    let anonymousToolCall = 0;
    let sawEnd = false;

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

        // Tool activity. Pi emits a toolCallId for normal events; fall back to
        // tool-name matching when replaying older/id-less streams.
        const toolCallId = typeof e.toolCallId === "string" ? e.toolCallId : undefined;
        if (type === "tool_execution_start") {
            const toolName = typeof e.toolName === "string" ? e.toolName : "unknown";
            if (toolCalls[toolCalls.length - 1] !== toolName) toolCalls.push(toolName);
            openToolCalls.set(toolCallId ?? `anonymous:${anonymousToolCall++}`, { id: toolCallId, toolName });
        }
        if (type === "tool_execution_end") {
            if (toolCallId) {
                openToolCalls.delete(toolCallId);
            } else if (typeof e.toolName === "string") {
                const matching = [...openToolCalls].find(([, call]) => call.toolName === e.toolName);
                if (matching) openToolCalls.delete(matching[0]);
            }
        }
    }

    if (!finalText && !lastActivity && toolCalls.length === 0) {
        diagnostics.push("No parseable assistant/tool events found in the log tail.");
    }

    usage.total = usage.input + usage.output;
    return { finalText, lastActivity, toolCalls, unmatchedToolCalls: [...openToolCalls.values()], sawEnd, usage, diagnostics };
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
