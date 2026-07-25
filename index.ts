/**
 * pi-better-subagents — Claude Code-style async subagents for pi.
 *
 * Core semantic: launching a subagent IS the deliverable. `subagent_spawn`
 * starts a detached `pi -p` child and returns immediately with a run id; the
 * foreground session stays free for the human while it runs. When the child
 * finishes, its RESULT is posted back into the session (delivered as a followUp
 * so it never cuts into work in progress). The foreground is never BLOCKED on a
 * wait/poll loop — it's only nudged once, at completion, with the answer.
 *
 *   launch is the result · completion posts back · the foreground never blocks
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { spawnDetached, killProcessTree } from "./spawn.ts";
import { parseRun, tailLog, formatSubagentOutputBody, formatSubagentResultBody, type Usage } from "./parse.ts";

import { loadConfig, normalizeTools, resolveExtensionPath, SAFE_DEFAULT_TOOLS, SAFE_CLEAN_TOOLS, DEFAULT_MAX_CONCURRENT } from "./config.ts";
import { resolveExtensions, extensionArgs } from "./extensions.ts";
import { maybeBuildSandboxCommand } from "./sandbox.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    sessionsDir,
    runDir,
    logPathFor,
    promptPathFor,
    nextRunId,
    writeMeta,
    readMeta,
    listMetas,
    effectiveStatus,
    ownedByThisParent,
    type RunMeta,
} from "./registry.ts";
import {
    assignBatchJobNames,
    formatBatchLaunchResponse,
    mergeJobOptions,
    nextBatchId,
    planBatchLaunches,
    validateBatchPlan,
} from "./batch.mjs";
import { formatCallbackTrigger, formatCallbackQuiet, buildCompletionDelivery } from "./completion.ts";
import {
    SPINNER,
    TICK_MS,
    WIDGET_CLEAR,
    fmtElapsed,
    fmtSpend,
    buildWidgetLines,
    nextWidgetAction,
    isSpendCacheFresh,
} from "./widget.ts";
import {
    SUBAGENT_LIST_DEFAULT_LIMIT,
    SUBAGENT_LIST_MAX_LIMIT,
    SUBAGENT_LIST_STATUSES,
    buildSubagentList,
} from "./list.ts";

/** The tools this extension registers — excluded from children by default so a
 *  subagent cannot recursively spawn more subagents unless explicitly allowed. */
const SUBAGENT_TOOLS = [
    "subagent_spawn",
    "subagent_spawn_batch",
    "subagent_list",
    "subagent_output",
    "subagent_stop",
    "subagent_result",
];

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

// ---- live status widget (Claude Code-style) ------------------------------
//
// Pi's setWidget(string[]) path disposes + rebuilds the above-editor component
// tree on every call. Calling it at 1 Hz with a changing spinner/elapsed/spend
// thrashes layout and makes neighboring ▶ job-* lines flicker. Mitigations:
//   1. dirty-check via nextWidgetAction — skip identical frames
//   2. fixed-width elapsed/tokens (buildWidgetLines) — stable geometry
//   3. clear with undefined (WIDGET_CLEAR), never []
//   4. cache spend/tool; only re-parseRun when log grows or TTL expires
// Pure helpers live in widget.mjs / widget.ts so unit tests cover the contracts
// without a live TUI.

/** Freshest UI-bearing context, captured from session_start / tool calls. */
let uiCtx: ExtensionContext | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
let frame = 0;
/** Last lines successfully sent to setWidget (undefined ⇒ cleared / never set). */
let lastWidgetLines: string[] | undefined;

type SpendSnap = {
    usage: Usage;
    tool: string | null;
    refreshedAt: number;
    logSize: number;
};
/** Per-run spend/tool cache for the UI hot path. */
const spendCache = new Map<string, SpendSnap>();

function logSizeOf(id: string): number {
    try {
        return statSync(logPathFor(id)).size;
    } catch {
        return 0;
    }
}

/** Refresh spend/tool for a run only when the cache is stale or the log grew. */
function spendFor(id: string, now: number): { usage: Usage; tool: string | null } {
    const logSize = logSizeOf(id);
    const cached = spendCache.get(id);
    if (isSpendCacheFresh(cached, now, logSize)) {
        return { usage: cached!.usage, tool: cached!.tool };
    }
    const r = parseRun(id);
    const snap: SpendSnap = {
        usage: r.usage,
        tool: r.toolCalls.length ? r.toolCalls[r.toolCalls.length - 1]! : null,
        refreshedAt: now,
        logSize,
    };
    spendCache.set(id, snap);
    return { usage: snap.usage, tool: snap.tool };
}

function applyWidget(linesOrClear: string[] | typeof WIDGET_CLEAR): void {
    const ctx = uiCtx;
    if (!ctx || !ctx.hasUI) return;
    const action = nextWidgetAction(
        lastWidgetLines,
        linesOrClear === undefined ? null : linesOrClear,
    );
    if (action.op === "skip") return;
    if (action.op === "clear") {
        try { ctx.ui.setWidget("subagents", WIDGET_CLEAR); } catch { /* ignore */ }
        lastWidgetLines = undefined;
        return;
    }
    try { ctx.ui.setWidget("subagents", action.lines); } catch { /* ignore */ }
    lastWidgetLines = action.lines;
}

/** Redraw the running-subagents widget above the editor; clear it when idle. */
function renderWidget(): void {
    const ctx = uiCtx;
    if (!ctx || !ctx.hasUI) return;
    const running = listMetas().filter((m) => ownedByThisParent(m) && effectiveStatus(m) === "running");
    if (running.length === 0) {
        applyWidget(WIDGET_CLEAR);
        // Drop spend entries for runs that are no longer live so a restart
        // does not show stale totals for a recycled id.
        spendCache.clear();
        stopTicker();
        return;
    }
    // Keep cache entries only for currently-running ids.
    const live = new Set(running.map((m) => m.id));
    for (const id of spendCache.keys()) {
        if (!live.has(id)) spendCache.delete(id);
    }
    frame = (frame + 1) % SPINNER.length;
    const now = Date.now();
    const spendById: Record<string, { usage: Usage; tool: string | null }> = {};
    for (const m of running) {
        spendById[m.id] = spendFor(m.id, now);
    }
    // buildWidgetLines includes shortModel(m.model) — preserves #14 list-show-model.
    const lines = buildWidgetLines({ running, frame, now, spendById });
    applyWidget(lines);
}

/** Start the redraw loop if a UI is present and it isn't already running. */
function ensureTicker(): void {
    if (ticker || !uiCtx?.hasUI) return;
    ticker = setInterval(renderWidget, TICK_MS);
    ticker.unref?.(); // never keep the process alive on our account
    renderWidget();
}

function stopTicker(): void {
    if (ticker) { clearInterval(ticker); ticker = undefined; }
}

/** Resolve the pi binary once per session. */
let cachedPi: string | undefined;
function resolvePiBinary(): string {
    if (cachedPi !== undefined) return cachedPi;
    try {
        cachedPi = execSync("which pi", { encoding: "utf-8", timeout: 3000 }).trim();
    } catch {
        cachedPi = "pi";
    }
    return cachedPi;
}


/**
 * Finalize a run once its child exits. Idempotent: a run already marked
 * terminal is left alone. Notifies the foreground non-intrusively.
 */
function finalizeRun(pi: ExtensionAPI, ctx: ExtensionContext, id: string, code: number | null): void {
    const meta = readMeta(id);
    if (!meta || meta.status !== "running") return;
    meta.status = code === 0 || code === null ? "completed" : "failed";
    meta.exitCode = code;
    meta.endedAt = Date.now();
    writeMeta(meta);

    const label = meta.name ? `${meta.name} (${id})` : id;
    const verdict = meta.status === "completed" ? "✓ completed" : `✗ failed (exit ${code})`;
    const el = fmtElapsed(meta.endedAt - meta.startedAt);
    const r = parseRun(id);
    const spend = fmtSpend(r.usage);
    const stat = `${el}${spend ? ` · ${spend}` : ""}`;
    const tools = r.toolCalls.length ? r.toolCalls.join(", ") : undefined;

    // A finished run is no longer in the widget; redraw (and stop the ticker if
    // it was the last one).
    renderWidget();

    // Best-effort human toast. ctx may be stale by now; never let it throw.
    try { ctx.ui.notify(`Subagent ${label} ${verdict} · ${stat}`, meta.status === "completed" ? "info" : "warning"); } catch { /* ignore */ }

    const callback = meta.callback !== false; // default: trigger completion
    // buildCompletionDelivery is the single place sendMessage content/options are
    // assembled. resultText is accepted here so callers/tests can pass it without
    // breaking, but it is NEVER put into content — the result lives in subagent_result.
    const delivery = buildCompletionDelivery({
        id, label, verdict, stat, tools,
        callback,
        resultText: r.finalText || r.lastActivity || "",
    });
    pi.sendMessage(
        { customType: "subagent-complete", content: delivery.content, display: true },
        delivery.options,
    );
}

export default function (pi: ExtensionAPI) {
    type SpawnParams = {
        prompt: string; name?: string; model?: string; tools?: string;
        exclude_tools?: string; clean?: boolean; sandbox?: boolean;
        sandbox_dir?: string; callback?: boolean; cwd?: string;
        approve?: boolean; allow_nested?: boolean;
    };

    /**
     * Shared internal spawn path used by both subagent_spawn and
     * subagent_spawn_batch. Every launched job becomes a normal subagent run
     * with its own run ID, process, log, metadata, callback, result/output/stop
     * behavior, and sandboxing.
     */
    async function spawnSubagentRun(
        ctx: ExtensionContext,
        p: SpawnParams,
        batchInfo?: { batchId: string; batchName?: string },
    ): Promise<{
        id: string;
        meta: RunMeta;
        spawned: SpawnResult;
        runtime: string;
        warn: string;
        sandboxDir?: string;
    }> {
        const cfg = loadConfig();

        const explicitSandbox = p.sandbox === true || typeof p.sandbox_dir === "string";
        const sandboxEnabled = p.sandbox !== false; // default on
        const cwd = p.sandbox_dir ?? p.cwd ?? ctx.cwd;
        const requestedSandboxDir = sandboxEnabled ? (p.sandbox_dir ?? cwd) : undefined;
        const model = p.model ?? cfg.defaultModel ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

        mkdirSync(sessionsDir(), { recursive: true });
        const id = nextRunId();
        mkdirSync(runDir(id), { recursive: true });
        if (requestedSandboxDir) mkdirSync(requestedSandboxDir, { recursive: true });
        writeFileSync(promptPathFor(id), p.prompt);

        const clean = p.clean === true;

        let allow = normalizeTools(
            p.tools ?? cfg.defaultTools ?? (clean ? SAFE_CLEAN_TOOLS : SAFE_DEFAULT_TOOLS),
        );
        if (p.allow_nested) {
            const have = new Set(allow.split(","));
            allow = [...allow.split(","), ...SUBAGENT_TOOLS.filter((t) => !have.has(t))]
                .filter(Boolean).join(",");
        }

        const resolution = resolveExtensions({
            tools: allow, model, clean, allowNested: p.allow_nested, config: cfg,
        });
        const { args: extArgs, missing } = extensionArgs(resolution, resolveExtensionPath);
        if (missing.length) {
            throw new Error(
                `Subagent needs extension(s) that are not installed: ${missing.join(", ")}. ` +
                `Install them, drop the tools that require them, or remove the mapping from config.json.`,
            );
        }

        const excludes = new Set<string>();
        if (p.exclude_tools) for (const t of p.exclude_tools.split(",")) if (t.trim()) excludes.add(t.trim());
        if (!p.allow_nested && resolution.mode === "inherit") {
            for (const t of SUBAGENT_TOOLS) excludes.add(t);
        }

        const args = [
            "-p", "--mode", "json",
            "--session-dir", sessionsDir(),
            "--session-id", id,
            ...extArgs,
            ...(model ? ["--model", model] : []),
            ...(allow ? ["--tools", allow] : []),
            ...(excludes.size ? ["--exclude-tools", [...excludes].join(",")] : []),
            ...(p.approve ? ["--approve"] : []),
            p.prompt,
        ];

        const piBin = resolvePiBinary();
        const sandboxCommand = requestedSandboxDir
            ? maybeBuildSandboxCommand({
                profilePath: join(runDir(id), "sandbox.sb"),
                writableDir: requestedSandboxDir, home: homedir(), piBin, piArgs: args,
            }, { sandboxEnabled, explicitSandbox })
            : undefined;
        const cmd = sandboxCommand ?? { file: piBin, fileArgs: args };
        const sandboxDir = sandboxCommand ? requestedSandboxDir : undefined;

        const spawned = spawnDetached({ file: cmd.file, fileArgs: cmd.fileArgs, cwd, logPath: logPathFor(id) });

        const meta: RunMeta = {
            id, name: p.name, status: "running",
            pid: spawned.pid, spawnPid: process.pid, model, cwd,
            promptPreview: p.prompt.slice(0, 200),
            startedAt: Date.now(), logPath: logPathFor(id), sessionId: id,
            sandbox: sandboxDir, callback: p.callback !== false,
            ...batchInfo,
        };
        writeMeta(meta);

        void spawned.exit.then((code) => finalizeRun(pi, ctx, id, code));

        uiCtx = ctx;
        ensureTicker();

        const runtime = resolution.mode === "inherit"
            ? `Runtime: ALL installed extensions (inheritExtensions) — mid-turn drain risk\n`
            : resolution.specs.length
                ? `Runtime: isolated · extensions ${resolution.specs.join(", ")}\n`
                : `Runtime: isolated · built-in tools only\n`;
        const warn = resolution.unmapped.length
            ? `NOTE: no extension mapped for ${resolution.unmapped.join(", ")} — ` +
              `${resolution.unmapped.length > 1 ? "these tools" : "this tool"} will NOT exist in the child. ` +
              `Add a toolExtensions entry in config.json.\n`
            : "";
        return { id, meta, spawned, runtime, warn, sandboxDir };
    }

    // ---- subagent_spawn -------------------------------------------------
    pi.registerTool({
        name: "subagent_spawn",
        label: "Spawn Subagent",
        description:
            "Launch a task in a background pi subagent (a detached `pi -p` process) and return " +
            "IMMEDIATELY with a run id. The foreground session stays free. Completion is reported " +
            "later on the user's next turn — never wait or poll for it.",
        promptSnippet: "Delegate a task to a background subagent that runs without blocking you",
        promptGuidelines: [
            "Use subagent_spawn for independent work the user should not have to wait on. It returns at once with a run id; that return IS the deliverable — report the id to the user and continue.",
            "After subagent_spawn, do NOT call subagent_output or subagent_result in a loop to wait for the result, and do NOT sleep. The run completes on its own and reports back on the next turn.",
            "Only call subagent_result / subagent_output when the user explicitly asks how a run is going or for its result.",
            "The tools param is both the tool allowlist AND what determines which extensions load in the child (e.g. tools='read,bash,web_fetch' loads only the web-tools package). Ask for the tools the task needs and nothing more; clean:true gives a built-ins-only child. Pick a model with the model param (e.g. 'xai/grok-4.5').",
            "By default the subagent is sandboxed (writes confined to its working dir, reads and network open) and triggers completion here on finish. Set callback:false to finish quietly — then read the result on demand via subagent_result.",
        ],
        parameters: Type.Object({
            prompt: Type.String({ description: "The task for the subagent. This is the only context it gets — be self-contained." }),
            name: Type.Optional(Type.String({ description: "Short label for the run (e.g. 'reviewer')." })),
            model: Type.Optional(Type.String({ description: "Model as provider/id (default: inherit foreground model)." })),
            tools: Type.Optional(Type.String({ description: "Tool allowlist: comma-separated names the child may use (e.g. 'read,bash,web_fetch'). This ALSO selects which extensions load — only packages backing a requested tool are loaded. Defaults to the configured safe set." })),
            exclude_tools: Type.Optional(Type.String({ description: "Comma-separated tool denylist, applied on top of the allowlist." })),
            clean: Type.Optional(Type.Boolean({ description: "Run a hermetic child with NO extensions at all (only built-ins: read, bash, edit, write). Default false — the extensions backing the requested tools load, so web_fetch and model auth (e.g. xai) work." })),
            sandbox: Type.Optional(Type.Boolean({ description: "Default TRUE (macOS): kernel-confine the child's file WRITES to its working dir — reads and network stay open, but it cannot write outside, whatever it runs. Set false to allow writes anywhere." })),
            sandbox_dir: Type.Optional(Type.String({ description: "Confine writes to (and run the child in) this directory instead of the working dir. Created if missing." })),
            callback: Type.Optional(Type.Boolean({ description: "Default TRUE: on completion, trigger a turn that calls subagent_result and presents the result. Set false to finish quietly — the result is then read on demand via subagent_result." })),
            cwd: Type.Optional(Type.String({ description: "Working directory (default: current)." })),
            approve: Type.Optional(Type.Boolean({ description: "Trust project-local files in the child (default: false; headless runs cannot prompt for trust)." })),
            allow_nested: Type.Optional(Type.Boolean({ description: "Allow the child to spawn its own subagents (default: false). Loads this extension in the child and allowlists its tools." })),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as SpawnParams;
            if (p.prompt.trim() === "") throw new Error("prompt is empty.");

            const cfg = loadConfig();
            const maxConcurrent = cfg.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
            const running = listMetas().filter((m) => ownedByThisParent(m) && effectiveStatus(m) === "running").length;
            if (running >= maxConcurrent) {
                throw new Error(`Max concurrent subagents (${maxConcurrent}) reached. Stop or let some finish first.`);
            }

            const { id, spawned, runtime, warn, sandboxDir } = await spawnSubagentRun(ctx, p);
            return text(
                `Subagent launched: ${p.name ? `${p.name} ` : ""}id=${id} (pid ${spawned.pid}).\n` +
                (p.callback === false
                    ? `Running in the background; the foreground is free. It will finish quietly — read the result with subagent_result id=${id}.\n`
                    : `Running in the background; the foreground is free. Its result will be posted back here when it finishes.\n`) +
                (sandboxDir ? `Sandboxed: writes confined to ${sandboxDir}\n` : "") +
                runtime + warn +
                `Log: ${logPathFor(id)}`,
            );
        },
    });

    // ---- subagent_spawn_batch -------------------------------------------
    pi.registerTool({
        name: "subagent_spawn_batch",
        label: "Spawn Subagent Batch",
        description:
            "Launch several independent background pi subagents at once. Each job becomes a " +
            "normal subagent run with its own run id, process, log, and metadata. " +
            "'shared' options are applied to every job; per-job options override them.",
        promptSnippet: "Launch a batch of background subagents at once",
        promptGuidelines: [
            "Use subagent_spawn_batch when you have several independent tasks to delegate. It returns immediately with a batch id and one run id per launched job.",
            "Each job is a normal subagent run; use subagent_result / subagent_output / subagent_stop with the individual run ids just like subagent_spawn.",
            "Do NOT poll for results. Each job reports back on its own when it finishes.",
            "By default the whole batch is rejected if there is not enough capacity. Set onCapacity to 'launch-available' to launch as many as fit and report the rest as skipped.",
        ],
        parameters: Type.Object({
            batchName: Type.Optional(Type.String({ description: "Optional display label for the batch." })),
            shared: Type.Optional(Type.Object({
                model: Type.Optional(Type.String({ description: "Model as provider/id (default: inherit foreground model)." })),
                tools: Type.Optional(Type.String({ description: "Tool allowlist applied to every job." })),
                exclude_tools: Type.Optional(Type.String({ description: "Comma-separated tool denylist applied to every job." })),
                sandbox: Type.Optional(Type.Boolean({ description: "Default TRUE: kernel-confine writes to the working dir." })),
                sandbox_dir: Type.Optional(Type.String({ description: "Writable root for every job." })),
                callback: Type.Optional(Type.Boolean({ description: "Default TRUE: post result back on completion." })),
                clean: Type.Optional(Type.Boolean({ description: "Hermetic builtins-only child; no extensions load." })),
                cwd: Type.Optional(Type.String({ description: "Working directory (default: current)." })),
                approve: Type.Optional(Type.Boolean({ description: "Trust project-local files in children." })),
                allow_nested: Type.Optional(Type.Boolean({ description: "Allow children to spawn their own subagents." })),
            }, { description: "Options applied to every job; per-job values override these." })),
            jobs: Type.Array(Type.Object({
                prompt: Type.String({ description: "The task for this job." }),
                name: Type.Optional(Type.String({ description: "Short label for this job." })),
                model: Type.Optional(Type.String()),
                tools: Type.Optional(Type.String()),
                exclude_tools: Type.Optional(Type.String()),
                sandbox: Type.Optional(Type.Boolean()),
                sandbox_dir: Type.Optional(Type.String()),
                callback: Type.Optional(Type.Boolean()),
                clean: Type.Optional(Type.Boolean()),
                cwd: Type.Optional(Type.String()),
                approve: Type.Optional(Type.Boolean()),
                allow_nested: Type.Optional(Type.Boolean()),
            }, { description: "A single batch job." }), {
                minItems: 1,
                description: "One or more jobs to launch. Each must have a prompt.",
            }),
            onCapacity: Type.Optional(Type.String({ description: 'Capacity behavior: "reject" (default) or "launch-available".' })),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as {
                batchName?: string;
                shared?: Partial<SpawnParams>;
                jobs: Array<Partial<SpawnParams> & { prompt: string }>;
                onCapacity?: "reject" | "launch-available";
            };

            const cfg = loadConfig();
            const maxConcurrent = cfg.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
            const running = listMetas().filter((m) => ownedByThisParent(m) && effectiveStatus(m) === "running").length;

            validateBatchPlan({ shared: p.shared, jobs: p.jobs, onCapacity: p.onCapacity, config: cfg });
            const plan = planBatchLaunches({
                jobs: p.jobs,
                runningCount: running,
                maxConcurrent,
                onCapacity: p.onCapacity,
            });
            const names = assignBatchJobNames(p.jobs);
            const batchId = nextBatchId();

            const launched: { name: string; id: string }[] = [];
            const failed: { name: string; reason: string }[] = [];
            for (let i = 0; i < plan.toLaunch.length; i++) {
                const job = plan.toLaunch[i];
                const index = p.jobs.indexOf(job);
                const merged = mergeJobOptions(p.shared, job);
                const name = names[index];

                // Re-check capacity before each async launch. Between launches other
                // subagent_spawn calls may have consumed slots; stop rather than exceed
                // the configured cap. Already-launched runs are left running.
                const currentRunning = listMetas().filter(
                    (m) => ownedByThisParent(m) && effectiveStatus(m) === "running",
                ).length;
                if (currentRunning >= maxConcurrent) {
                    const remaining = plan.toLaunch.slice(i).map((j) => ({
                        name: names[p.jobs.indexOf(j)],
                    }));
                    if (p.onCapacity === "launch-available") {
                        return text(formatBatchLaunchResponse({
                            batchId, batchName: p.batchName, launched, skipped: [...plan.skipped.map((j) => ({ name: names[p.jobs.indexOf(j)] })), ...remaining], failed,
                        }));
                    }
                    failed.push({ name, reason: "capacity exhausted by concurrent launches before this job could start" });
                    return text(formatBatchLaunchResponse({
                        batchId, batchName: p.batchName, launched, skipped: plan.skipped.map((j) => ({ name: names[p.jobs.indexOf(j)] })), failed,
                    }));
                }

                try {
                    const { id } = await spawnSubagentRun(ctx, { ...merged, name }, { batchId, batchName: p.batchName });
                    launched.push({ name, id });
                } catch (err) {
                    const reason = err instanceof Error ? err.message : String(err);
                    failed.push({ name, reason });
                    if (p.onCapacity !== "launch-available") {
                        // reject mode: the whole batch was supposed to fit; fail fast
                        // and report what launched before the failure without stopping it.
                        return text(formatBatchLaunchResponse({
                            batchId, batchName: p.batchName, launched, skipped: plan.skipped.map((j) => ({ name: names[p.jobs.indexOf(j)] })), failed,
                        }));
                    }
                    // launch-available: continue trying the rest so we maximize useful work.
                }
            }

            const skipped = plan.skipped.map((job) => ({ name: names[p.jobs.indexOf(job)] }));
            return text(formatBatchLaunchResponse({ batchId, batchName: p.batchName, launched, skipped, failed }));
        },
    });

    // ---- subagent_list --------------------------------------------------
    pi.registerTool({
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
        async execute(_toolCallId, params) {
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
    });

    // ---- subagent_output ------------------------------------------------
    pi.registerTool({
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
        async execute(_id, params) {
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
    });

    // ---- subagent_result ------------------------------------------------
    pi.registerTool({
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
        async execute(_id, params) {
            const p = params as { id: string };
            const meta = readMeta(p.id);
            if (!meta) throw new Error(`Unknown run id: ${p.id}`);
            const st = effectiveStatus(meta);
            if (st === "running") {
                return text(`Run ${p.id} is still running — no result yet. You'll be notified when it finishes; don't poll.`);
            }
            const exit = meta.exitCode === undefined ? "?" : String(meta.exitCode);
            const r = parseRun(p.id);
            const el = fmtElapsed((meta.endedAt ?? Date.now()) - meta.startedAt);
            const spend = fmtSpend(r.usage);
            const statSeg = ` · ${el}${spend ? ` · ${spend}` : ""}`;
            const tools = r.toolCalls.length ? ` · tools: ${r.toolCalls.join(", ")}` : "";
            // Clean final answer parsed from the JSON stream. Fall back to the raw
            // log tail only if parsing found nothing (e.g. a child that crashed
            // before emitting any assistant message).
            const rawTail = tailLog(p.id, 40);
            return text(formatSubagentResultBody(
                `[${p.id} · ${st} · exit ${exit}${statSeg}${tools}]`,
                r.finalText || undefined,
                rawTail,
                r.diagnostics,
            ));
        },
    });

    // ---- subagent_stop --------------------------------------------------
    pi.registerTool({
        name: "subagent_stop",
        label: "Stop Subagent",
        description: "Terminate a running subagent (SIGTERM to its process group).",
        promptSnippet: "Stop a running background subagent",
        parameters: Type.Object({
            id: Type.String({ description: "Run id from subagent_spawn." }),
        }),
        async execute(_id, params) {
            const p = params as { id: string };
            const meta = readMeta(p.id);
            if (!meta) throw new Error(`Unknown run id: ${p.id}`);
            if (effectiveStatus(meta) !== "running") {
                return text(`Run ${p.id} is not running (${effectiveStatus(meta)}).`);
            }
            killProcessTree(meta.pid, "SIGTERM");
            meta.status = "killed";
            meta.endedAt = Date.now();
            writeMeta(meta);
            renderWidget();
            return text(`Stopped subagent ${p.id}.`);
        },
    });

    // ---- live-status lifecycle -----------------------------------------
    // Capture a UI-bearing context and, if runs from a prior session are still
    // alive, resume the ticking widget. Deferred out of the factory per pi's
    // "no background resources at load" rule.
    pi.on("session_start", async (_event, ctx) => {
        uiCtx = ctx;
        if (listMetas().some((m) => ownedByThisParent(m) && effectiveStatus(m) === "running")) ensureTicker();
        else renderWidget();
    });

    // Tear down the timer and clear the widget when the session ends.
    pi.on("session_shutdown", async (_event, ctx) => {
        stopTicker();
        spendCache.clear();
        try { ctx.ui.setWidget("subagents", WIDGET_CLEAR); } catch { /* ignore */ }
        lastWidgetLines = undefined;
    });
}
