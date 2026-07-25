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
 * Max prefix retained for one NDJSON record while hunting lifecycle fields.
 * Large single-line events never grow an in-memory leftover beyond this bound;
 * payloads after the prefix are discarded until the next newline.
 */
export const LIFECYCLE_RECORD_PREFIX_BYTES = 4 * 1024;

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

function applyLifecycleLine(
    line: string,
    openToolCalls: Map<string, UnmatchedToolCall>,
    state: { sawEnd: boolean; anonymousToolCall: number },
): void {
    const s = line.trim();
    if (!s || s[0] !== "{") return;
    let e: Record<string, unknown>;
    try { e = JSON.parse(s); } catch { return; }

    applyLifecycleFields(
        {
            type: typeof e.type === "string" ? e.type : undefined,
            toolCallId: typeof e.toolCallId === "string" ? e.toolCallId : undefined,
            toolName: typeof e.toolName === "string" ? e.toolName : undefined,
        },
        openToolCalls,
        state,
    );
}

/**
 * Pull only the top-level lifecycle strings from a record prefix.
 * Never JSON.parses the payload, so huge agent_end/tool result bodies stay off-heap.
 */
function extractLifecycleFieldsFromPrefix(prefix: string): {
    type?: string;
    toolCallId?: string;
    toolName?: string;
    /** True when the prefix is a JSON object and a complete "type" string was found. */
    foundType: boolean;
    /** True when prefix looks like a JSON object start but type was not yet visible. */
    looksLikeJsonObject: boolean;
} {
    const s = prefix.trimStart();
    if (!s || s[0] !== "{") {
        return { foundType: false, looksLikeJsonObject: false };
    }

    // Top-level string fields only. Values must be fully closed inside the prefix
    // so a chunk boundary never yields a partial field value.
    const typeMatch = /"type"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(s);
    const toolCallIdMatch = /"toolCallId"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(s);
    const toolNameMatch = /"toolName"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(s);

    const unescapeJsonString = (raw: string): string => {
        try {
            return JSON.parse(`"${raw}"`) as string;
        } catch {
            return raw;
        }
    };

    if (!typeMatch) {
        return { foundType: false, looksLikeJsonObject: true };
    }

    return {
        type: unescapeJsonString(typeMatch[1]),
        toolCallId: toolCallIdMatch ? unescapeJsonString(toolCallIdMatch[1]) : undefined,
        toolName: toolNameMatch ? unescapeJsonString(toolNameMatch[1]) : undefined,
        foundType: true,
        looksLikeJsonObject: true,
    };
}

/**
 * Stream the complete child log for lifecycle authority only.
 * Reads fixed-size chunks and never retains more than a small per-record prefix,
 * so large newline-free NDJSON events cannot grow heap with the event payload.
 * When a record is capped without extractable lifecycle fields, evidence is marked
 * incomplete so classification fails closed.
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
    let leftover = "";
    let skipToNewline = false;
    let currentRecordApplied = false;
    let complete = true;

    const markCappedUnknown = (): void => {
        complete = false;
        const msg = "Lifecycle scan capped oversized NDJSON record without extractable fields";
        if (!diagnostics.includes(msg)) diagnostics.push(msg);
    };

    const applyPrefixAndSkip = (prefix: string): void => {
        if (!currentRecordApplied) {
            const fields = extractLifecycleFieldsFromPrefix(prefix);
            if (fields.foundType) {
                applyLifecycleFields(fields, openToolCalls, state);
            } else if (fields.looksLikeJsonObject) {
                // JSON-looking record larger than the prefix with no visible type:
                // refuse clean completion rather than guessing.
                markCappedUnknown();
            }
            currentRecordApplied = true;
        }
        leftover = "";
        skipToNewline = true;
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

            let chunk = buf.toString("utf-8", 0, read);
            let cursor = 0;
            while (cursor < chunk.length) {
                if (skipToNewline) {
                    const nl = chunk.indexOf("\n", cursor);
                    if (nl === -1) {
                        cursor = chunk.length;
                        break;
                    }
                    cursor = nl + 1;
                    skipToNewline = false;
                    currentRecordApplied = false;
                    continue;
                }

                const nl = chunk.indexOf("\n", cursor);
                if (nl !== -1) {
                    const line = leftover + chunk.slice(cursor, nl);
                    leftover = "";
                    cursor = nl + 1;
                    if (!currentRecordApplied) {
                        if (line.length <= LIFECYCLE_RECORD_PREFIX_BYTES) {
                            applyLifecycleLine(line, openToolCalls, state);
                        } else {
                            // Full line exceeded the prefix bound; still only keep fields.
                            const fields = extractLifecycleFieldsFromPrefix(
                                line.slice(0, LIFECYCLE_RECORD_PREFIX_BYTES),
                            );
                            if (fields.foundType) {
                                applyLifecycleFields(fields, openToolCalls, state);
                            } else if (fields.looksLikeJsonObject) {
                                markCappedUnknown();
                            }
                        }
                    }
                    currentRecordApplied = false;
                    continue;
                }

                // No newline in the remainder of this chunk from `cursor`.
                const rest = chunk.slice(cursor);
                if (leftover.length + rest.length <= LIFECYCLE_RECORD_PREFIX_BYTES) {
                    leftover += rest;
                    cursor = chunk.length;
                } else {
                    // Cap retained prefix, extract lifecycle fields, discard payload.
                    const need = Math.max(0, LIFECYCLE_RECORD_PREFIX_BYTES - leftover.length);
                    const prefix = need > 0 ? leftover + rest.slice(0, need) : leftover;
                    applyPrefixAndSkip(prefix);
                    // Still consume any newline that lives later in this same chunk.
                    cursor += need;
                    const nlInRest = chunk.indexOf("\n", cursor);
                    if (nlInRest !== -1) {
                        cursor = nlInRest + 1;
                        skipToNewline = false;
                        currentRecordApplied = false;
                    } else {
                        cursor = chunk.length;
                    }
                }
            }
            // Drop the chunk string promptly; only leftover/prefix state survives.
            chunk = "";
        }

        if (!skipToNewline && leftover && !currentRecordApplied) {
            if (leftover.length <= LIFECYCLE_RECORD_PREFIX_BYTES) {
                applyLifecycleLine(leftover, openToolCalls, state);
            } else {
                const fields = extractLifecycleFieldsFromPrefix(
                    leftover.slice(0, LIFECYCLE_RECORD_PREFIX_BYTES),
                );
                if (fields.foundType) {
                    applyLifecycleFields(fields, openToolCalls, state);
                } else if (fields.looksLikeJsonObject) {
                    markCappedUnknown();
                }
            }
        } else if (skipToNewline && !currentRecordApplied) {
            // EOF mid-record after cap without fields — already handled by applyPrefixAndSkip.
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
