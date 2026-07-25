/**
 * Model-facing tool definitions — the seam between pi registration and tests.
 *
 * index.ts registers EXACTLY the objects these factories return
 * (`pi.registerTool(subagentListTool(Type))`), so a test that invokes a
 * factory-built tool's `execute` exercises the same handler logic the model
 * reaches — there is no second, drift-prone copy of the list/output/result/
 * stop behavior.
 *
 * The factories take the `Type` schema builder as a parameter instead of
 * importing `@earendil-works/pi-ai` directly: that package only exists inside
 * the pi runtime, and keeping this module free of it lets `node --test` load
 * the handlers with a trivial stub (the parameters schema is inert data as
 * far as `execute` is concerned).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readMeta, listMetas, effectiveStatus, isFinalResultStatus } from "./registry.ts";
import { parseRun, tailLog, formatSubagentOutputBody, formatSubagentResultBody } from "./parse.ts";
import { formatIncompleteResult } from "./lifecycle.ts";
import { stopRun } from "./stop.ts";
import { fmtElapsed, fmtSpend } from "./widget.ts";
import {
    SUBAGENT_LIST_DEFAULT_LIMIT,
    SUBAGENT_LIST_MAX_LIMIT,
    SUBAGENT_LIST_STATUSES,
    buildSubagentList,
} from "./list.ts";

/** The slice of `@earendil-works/pi-ai`'s Type the tool schemas use. */
type TypeModule = {
    Object: (v: unknown) => unknown;
    String: (v?: unknown) => unknown;
    Number: (v?: unknown) => unknown;
    Boolean: (v?: unknown) => unknown;
    Array: (v: unknown, o?: unknown) => unknown;
    Optional: (v: unknown) => unknown;
};

/** pi's tool-result text shape. */
export const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** A registered-tool definition as `pi.registerTool` accepts it. */
type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

// ---- subagent_list --------------------------------------------------------
export function subagentListTool(Type: TypeModule): ToolDefinition {
    return {
        name: "subagent_list",
        label: "List Subagents",
        description:
            `List background subagent runs with status and metadata. Non-blocking. ` +
            `Default: this parent process only, newest first, limit ${SUBAGENT_LIST_DEFAULT_LIMIT}. ` +
            `Pass all:true for machine-global; limit is clamped to max ${SUBAGENT_LIST_MAX_LIMIT}.`,
        promptSnippet: "List background subagent runs and their status",
        parameters: Type.Object({
            all: Type.Optional(Type.Boolean({ description: "If true, list every run on this machine. Default false = only runs spawned by this pi process." })),
            limit: Type.Optional(Type.Number({ description: `Maximum rows to display (default ${SUBAGENT_LIST_DEFAULT_LIMIT}, max ${SUBAGENT_LIST_MAX_LIMIT}; larger values are clamped).` })),
            status: Type.Optional(Type.Array(Type.String(), { description: `Effective statuses to include: ${SUBAGENT_LIST_STATUSES.join(", ")}.` })),
        }),
        async execute(_toolCallId: string, params: unknown) {
            const p = (params ?? {}) as { all?: boolean; limit?: number; status?: string[] | string };
            return text(buildSubagentList({
                metas: listMetas(),
                params: p,
                parentPid: process.pid,
                now: Date.now(),
                statusOf: effectiveStatus,
                usageById: (id: string) => parseRun(id).usage,
            }));
        },
    } as ToolDefinition;
}

// ---- subagent_output ------------------------------------------------------
export function subagentOutputTool(Type: TypeModule): ToolDefinition {
    return {
        name: "subagent_output",
        label: "Subagent Output",
        description:
            "Tail the live output of a subagent run. Non-blocking: returns whatever exists right now and " +
            "returns immediately whether or not the run has finished. Never waits.",
        promptSnippet: "Peek at a subagent's current output without waiting",
        promptGuidelines: [
            "Use subagent_output only when the user explicitly asks how a run is progressing. It never waits — do not call it in a loop.",
        ],
        parameters: Type.Object({
            id: Type.String({ description: "Run id from subagent_spawn." }),
            tail_lines: Type.Optional(Type.Number({ description: "How many trailing lines to show (default 40)." })),
        }),
        async execute(_id: string, params: unknown) {
            const p = params as { id: string; tail_lines?: number };
            const meta = readMeta(p.id);
            if (!meta) throw new Error(`Unknown run id: ${p.id}`);
            const st = effectiveStatus(meta);
            const r = parseRun(p.id);
            const el = fmtElapsed((meta.endedAt ?? Date.now()) - meta.startedAt);
            const spend = fmtSpend(r.usage);
            const head = `[${p.id} · ${st} · ${el}${spend ? ` · ${spend}` : ""}]`;
            const tools = r.toolCalls.length ? `\ntools used: ${r.toolCalls.join(", ")}` : "";
            const raw = tailLog(p.id, p.tail_lines ?? 40);
            return text(formatSubagentOutputBody(head, tools, r.finalText || r.lastActivity || undefined, raw, r.diagnostics));
        },
    } as ToolDefinition;
}

// ---- subagent_result ------------------------------------------------------
export function subagentResultTool(Type: TypeModule): ToolDefinition {
    return {
        name: "subagent_result",
        label: "Subagent Result",
        description:
            "Read a subagent's final output if it has finished. NEVER waits: if the run is still going it " +
            "says so and returns immediately.",
        promptSnippet: "Read a finished subagent's final result (never waits)",
        promptGuidelines: [
            "Use subagent_result to collect a finished run's output. If it reports the run is still going, stop — do not poll; you'll be notified when it finishes.",
        ],
        parameters: Type.Object({
            id: Type.String({ description: "Run id from subagent_spawn." }),
        }),
        async execute(_id: string, params: unknown) {
            const p = params as { id: string };
            const meta = readMeta(p.id);
            if (!meta) throw new Error(`Unknown run id: ${p.id}`);
            const st = effectiveStatus(meta);
            if (!isFinalResultStatus(st)) {
                if (st === "orphaned") {
                    // Non-terminal: supervision is broken but related process-
                    // group work may still be alive — never present this as a
                    // final result.
                    return text(
                        `Run ${p.id} is orphaned — supervision was lost, but related processes may still be alive. ` +
                        `There is no final result; use subagent_output for current (possibly still changing) output.`,
                    );
                }
                return text(`Run ${p.id} is still running — no result yet. You'll be notified when it finishes; don't poll.`);
            }
            const exit = meta.exitCode === undefined ? "?" : String(meta.exitCode);
            const r = parseRun(p.id);
            const el = fmtElapsed((meta.endedAt ?? Date.now()) - meta.startedAt);
            const spend = fmtSpend(r.usage);
            const statSeg = ` · ${el}${spend ? ` · ${spend}` : ""}`;
            const tools = r.toolCalls.length ? ` · tools: ${r.toolCalls.join(", ")}` : "";
            const diagnostic = st === "lost"
                ? `\nRun is lost: no related process remains and no coherent terminal result was observed. Best-available artifacts below.`
                : "";
            const rawTail = tailLog(p.id, 40);
            if (meta.failureReason === "incomplete-stream") {
                return text(`[${p.id} · ${st} · exit ${exit}${statSeg}${tools}]\n${formatIncompleteResult(r, rawTail)}`);
            }
            return text(formatSubagentResultBody(
                `[${p.id} · ${st} · exit ${exit}${statSeg}${tools}]${diagnostic}`,
                r.finalText || undefined,
                rawTail,
                r.diagnostics,
            ));
        },
    } as ToolDefinition;
}

// ---- subagent_stop --------------------------------------------------------
/**
 * Stop is the one tool with a UI side effect (widget redraw after a kill);
 * the caller injects it so the factory stays loadable without a TUI context.
 */
export function subagentStopTool(
    Type: TypeModule,
    deps: { onStopped?: () => void } = {},
): ToolDefinition {
    return {
        name: "subagent_stop",
        label: "Stop Subagent",
        description: "Terminate a running subagent (SIGTERM to its process group).",
        promptSnippet: "Stop a running background subagent",
        parameters: Type.Object({
            id: Type.String({ description: "Run id from subagent_spawn." }),
        }),
        async execute(_id: string, params: unknown) {
            const p = params as { id: string };
            // Shared stop semantics with the TUI navigator close action (#44):
            // stopRun rereads meta + effective status from disk before acting.
            const outcome = stopRun(p.id);
            if (outcome.action === "not-running") {
                return text(`Run ${p.id} is not running (${outcome.status}).`);
            }
            deps.onStopped?.();
            return text(`Stopped subagent ${p.id}.`);
        },
    } as ToolDefinition;
}
