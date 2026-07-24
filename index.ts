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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { spawnDetached, killProcessTree } from "./spawn.ts";
import { parseRun, type Usage } from "./parse.ts";
import { loadConfig, normalizeTools, SAFE_DEFAULT_TOOLS, SAFE_CLEAN_TOOLS, DEFAULT_MAX_CONCURRENT } from "./config.ts";
import { buildSandboxCommand, sandboxSupported } from "./sandbox.ts";
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
    type RunMeta,
} from "./registry.ts";
import { formatCallbackTrigger, formatCallbackQuiet } from "./completion.ts";

/** The tools this extension registers — excluded from children by default so a
 *  subagent cannot recursively spawn more subagents unless explicitly allowed. */
const SUBAGENT_TOOLS = [
    "subagent_spawn",
    "subagent_list",
    "subagent_output",
    "subagent_stop",
    "subagent_result",
];

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

// ---- status formatting ---------------------------------------------------

/** "45s" · "2m 03s" · "1h 04m". */
function fmtElapsed(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return `${m}m ${String(rs).padStart(2, "0")}s`;
    const h = Math.floor(m / 60), rm = m % 60;
    return `${h}h ${String(rm).padStart(2, "0")}m`;
}

/** "412" · "1.2k" · "27.9k" · "1.4M". */
function fmtTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
    return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Compact USD cost, e.g. "$0.0057" or "$1.23". */
function fmtCost(usd: number): string {
    if (usd <= 0) return "$0";
    return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** One-line spend summary, or "" when nothing has been spent yet. */
function fmtSpend(u: Usage): string {
    if (u.total <= 0 && u.costUSD <= 0) return "";
    return `${fmtTokens(u.total)} tok (↑${fmtTokens(u.input)} ↓${fmtTokens(u.output)}) · ${fmtCost(u.costUSD)}`;
}

// ---- live status widget (Claude Code-style) ------------------------------

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Freshest UI-bearing context, captured from session_start / tool calls. */
let uiCtx: ExtensionContext | undefined;
let ticker: ReturnType<typeof setInterval> | undefined;
let frame = 0;

/** Redraw the running-subagents widget above the editor; clear it when idle. */
function renderWidget(): void {
    const ctx = uiCtx;
    if (!ctx || !ctx.hasUI) return;
    const running = listMetas().filter((m) => effectiveStatus(m) === "running");
    if (running.length === 0) {
        try { ctx.ui.setWidget("subagents", []); } catch { /* ignore */ }
        stopTicker();
        return;
    }
    frame = (frame + 1) % SPINNER.length;
    const spin = SPINNER[frame];
    const now = Date.now();
    const lines = [`Subagents · ${running.length} running`];
    for (const m of running) {
        const el = fmtElapsed(now - m.startedAt);
        const r = parseRun(m.id);
        const spend = fmtSpend(r.usage);
        const tool = r.toolCalls.length ? ` · ${r.toolCalls[r.toolCalls.length - 1]}` : "";
        const nm = m.name ?? m.id;
        lines.push(`  ${spin} ${nm}  ${el}${tool}${spend ? `  ${spend}` : ""}`);
    }
    try { ctx.ui.setWidget("subagents", lines); } catch { /* ignore */ }
}

/** Start the 1s redraw loop if a UI is present and it isn't already running. */
function ensureTicker(): void {
    if (ticker || !uiCtx?.hasUI) return;
    ticker = setInterval(renderWidget, 1000);
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

/** Last `n` lines of a run's log, or a placeholder if empty/unreadable. */
function tailLog(id: string, n: number): string {
    let body: string;
    try {
        body = readFileSync(logPathFor(id), "utf-8");
    } catch {
        return "(no output yet)";
    }
    if (body.trim() === "") return "(no output yet)";
    const lines = body.split("\n");
    return lines.slice(Math.max(0, lines.length - n)).join("\n");
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
    if (callback) {
        // Callback ON: lightweight trigger message. `followUp` waits until the
        // foreground agent has no pending tool calls (never cutting into work
        // in progress); `triggerTurn` invokes a turn when idle so the model
        // calls subagent_result and presents the result. The actual result is
        // NEVER embedded here to avoid double-display. The foreground is never
        // BLOCKED while the run happens — this is a single callback at completion.
        pi.sendMessage(
            {
                customType: "subagent-complete",
                content: formatCallbackTrigger({ id, label, verdict, stat, tools }),
                display: true,
            },
            { deliverAs: "followUp", triggerTurn: true },
        );
    } else {
        // Callback OFF: do NOT trigger a turn. Leave a quiet note so the agent
        // knows it finished; the result is fetched on demand via subagent_result.
        // `nextTurn` delivers at the user's next prompt without interrupting.
        pi.sendMessage(
            {
                customType: "subagent-complete",
                content: formatCallbackQuiet({ id, label, verdict, stat }),
                display: true,
            },
            { deliverAs: "nextTurn" },
        );
    }
}

export default function (pi: ExtensionAPI) {
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
            "A subagent has the full tool set by default, including extension tools like web_fetch. Use the tools param to restrict it to an allowlist (e.g. tools='read,bash,web_fetch'), or clean:true for a hermetic built-ins-only child. Pick a model with the model param (e.g. 'xai/grok-4.5').",
            "By default the subagent is sandboxed (writes confined to its working dir, reads and network open) and triggers completion here on finish. Set callback:false to finish quietly — then read the result on demand via subagent_result.",
        ],
        parameters: Type.Object({
            prompt: Type.String({ description: "The task for the subagent. This is the only context it gets — be self-contained." }),
            name: Type.Optional(Type.String({ description: "Short label for the run (e.g. 'reviewer')." })),
            model: Type.Optional(Type.String({ description: "Model as provider/id (default: inherit foreground model)." })),
            tools: Type.Optional(Type.String({ description: "Tool allowlist: comma-separated names the child may use (e.g. 'read,bash,web_fetch'). Omit to allow all available tools (minus the subagent tools)." })),
            exclude_tools: Type.Optional(Type.String({ description: "Comma-separated tool denylist, applied on top of the allowlist." })),
            clean: Type.Optional(Type.Boolean({ description: "Run a hermetic child with NO global extensions (only built-ins: read, bash, edit, write). Default false — extensions load so web_fetch, MCP, and extension-provided model auth (e.g. xai) work." })),
            sandbox: Type.Optional(Type.Boolean({ description: "Default TRUE (macOS): kernel-confine the child's file WRITES to its working dir — reads and network stay open, but it cannot write outside, whatever it runs. Set false to allow writes anywhere." })),
            sandbox_dir: Type.Optional(Type.String({ description: "Confine writes to (and run the child in) this directory instead of the working dir. Created if missing." })),
            callback: Type.Optional(Type.Boolean({ description: "Default TRUE: on completion, trigger a turn that calls subagent_result and presents the result. Set false to finish quietly — the result is then read on demand via subagent_result." })),
            cwd: Type.Optional(Type.String({ description: "Working directory (default: current)." })),
            approve: Type.Optional(Type.Boolean({ description: "Trust project-local files in the child (default: false; headless runs cannot prompt for trust)." })),
            allow_nested: Type.Optional(Type.Boolean({ description: "Only relevant with load_extensions: allow the child to spawn its own subagents (default: false)." })),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const p = params as {
                prompt: string; name?: string; model?: string; tools?: string;
                exclude_tools?: string; clean?: boolean; sandbox?: boolean;
                sandbox_dir?: string; callback?: boolean; cwd?: string;
                approve?: boolean; allow_nested?: boolean;
            };
            if (p.prompt.trim() === "") throw new Error("prompt is empty.");

            const cfg = loadConfig();
            const maxConcurrent = cfg.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
            const running = listMetas().filter((m) => effectiveStatus(m) === "running").length;
            if (running >= maxConcurrent) {
                throw new Error(`Max concurrent subagents (${maxConcurrent}) reached. Stop or let some finish first.`);
            }

            const id = nextRunId();
            // Sandbox is ON by default (simple rule: reads free, writes confined
            // to the working dir). Opt out with sandbox:false. sandbox_dir moves
            // the confinement + working dir elsewhere. Self-contained confinement
            // via the OS — no dependency on any guardrails extension.
            const explicitSandbox = p.sandbox === true || typeof p.sandbox_dir === "string";
            let wantSandbox = p.sandbox !== false; // default on
            if (wantSandbox && !sandboxSupported()) {
                // Requested-but-unsupported is an error; default-on just degrades.
                if (explicitSandbox) throw new Error("sandbox is only supported on macOS (sandbox-exec). Pass sandbox:false on this platform.");
                wantSandbox = false;
            }
            const cwd = p.sandbox_dir ?? p.cwd ?? ctx.cwd;
            const sandboxDir = wantSandbox ? (p.sandbox_dir ?? cwd) : undefined;
            // Model precedence: per-call > config default > inherit foreground.
            const model = p.model ?? cfg.defaultModel ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

            // The child gets ONLY the explicit prompt — no silent parent-context
            // bleed. Bounded and deliberate, per the design's continuity rule.
            mkdirSync(sessionsDir(), { recursive: true });
            mkdirSync(runDir(id), { recursive: true });
            if (sandboxDir) mkdirSync(sandboxDir, { recursive: true });
            writeFileSync(promptPathFor(id), p.prompt);

            // Extensions load by default so the child has web_fetch, MCP, and
            // extension-provided model auth (e.g. xai/grok via pi-xai-oauth).
            // `clean:true` opts into a hermetic built-ins-only child.
            const clean = p.clean === true;

            // Tool allowlist precedence: per-call > config default > safe default
            // (built-ins-only when the child is hermetic, since extension tools
            // like web_fetch don't exist there).
            const allow = normalizeTools(
                p.tools ?? cfg.defaultTools ?? (clean ? SAFE_CLEAN_TOOLS : SAFE_DEFAULT_TOOLS),
            );

            const excludes = new Set<string>();
            // With extensions loaded, THIS extension loads in the child too, so
            // deny the subagent tools to stop unbounded recursion (unless the
            // caller explicitly allows nesting). In a clean child they don't exist.
            if (!clean && !p.allow_nested) for (const t of SUBAGENT_TOOLS) excludes.add(t);
            if (p.exclude_tools) for (const t of p.exclude_tools.split(",")) if (t.trim()) excludes.add(t.trim());

            const args = [
                "-p", "--mode", "json",
                "--session-dir", sessionsDir(),
                "--session-id", id,
                ...(clean ? ["--no-extensions"] : []),
                ...(model ? ["--model", model] : []),
                ...(allow ? ["--tools", allow] : []),
                ...(excludes.size ? ["--exclude-tools", [...excludes].join(",")] : []),
                ...(p.approve ? ["--approve"] : []),
                // Pass the task as a direct positional prompt, NOT `@file`: some
                // models (e.g. xiaomi/mimo) treat an @-attached file as untrusted
                // content and refuse to act on it. spawn() uses no shell, so the
                // full prompt is safe as a single argv element. The prompt.md
                // sidecar is kept only as a debugging record.
                p.prompt,
            ];

            const piBin = resolvePiBinary();
            // Route through sandbox-exec when confinement is requested; otherwise
            // exec pi directly.
            const cmd = sandboxDir
                ? buildSandboxCommand({
                    profilePath: join(runDir(id), "sandbox.sb"),
                    writableDir: sandboxDir, home: homedir(), piBin, piArgs: args,
                })
                : { file: piBin, fileArgs: args };

            const spawned = spawnDetached({ file: cmd.file, fileArgs: cmd.fileArgs, cwd, logPath: logPathFor(id) });

            const meta: RunMeta = {
                id, name: p.name, status: "running",
                pid: spawned.pid, spawnPid: process.pid, model, cwd,
                promptPreview: p.prompt.slice(0, 200),
                startedAt: Date.now(), logPath: logPathFor(id), sessionId: id,
                sandbox: sandboxDir, callback: p.callback !== false,
            };
            writeMeta(meta);

            // Fire-and-forget: finalize + notify when the child exits. No await —
            // the foreground turn returns now.
            void spawned.exit.then((code) => finalizeRun(pi, ctx, id, code));

            // Start the live status widget (elapsed + token spend, ticking).
            uiCtx = ctx;
            ensureTicker();

            return text(
                `Subagent launched: ${p.name ? `${p.name} ` : ""}id=${id} (pid ${spawned.pid}).\n` +
                (p.callback === false
                    ? `Running in the background; the foreground is free. It will finish quietly — read the result with subagent_result id=${id}.\n`
                    : `Running in the background; the foreground is free. Its result will be posted back here when it finishes.\n`) +
                (sandboxDir ? `Sandboxed: writes confined to ${sandboxDir}\n` : "") +
                `Log: ${logPathFor(id)}`,
            );
        },
    });

    // ---- subagent_list --------------------------------------------------
    pi.registerTool({
        name: "subagent_list",
        label: "List Subagents",
        description: "List background subagent runs (running and finished) with status and metadata. Non-blocking.",
        promptSnippet: "List background subagent runs and their status",
        parameters: Type.Object({}),
        async execute() {
            const metas = listMetas();
            if (metas.length === 0) return text("No subagent runs.");
            const now = Date.now();
            const rows = metas.map((m) => {
                const st = effectiveStatus(m);
                const el = fmtElapsed((m.endedAt ?? now) - m.startedAt);
                const spend = fmtSpend(parseRun(m.id).usage);
                const nm = m.name ? `${m.name} ` : "";
                const stat = `${el}${spend ? ` · ${spend}` : ""}`;
                return `• ${nm}${m.id}  [${st}]  ${stat}  ${m.model ?? ""}\n    ${m.promptPreview.replace(/\s+/g, " ").slice(0, 100)}`;
            });
            return text(rows.join("\n"));
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
            const body = r.finalText || r.lastActivity || "(no output yet)";
            return text(`${head}${tools}\n${body}`);
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
            const body = r.finalText || `(no final answer parsed)\n\n--- raw log tail ---\n${tailLog(p.id, 40)}`;
            return text(`[${p.id} · ${st} · exit ${exit}${statSeg}${tools}]\n${body}`);
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
        if (listMetas().some((m) => effectiveStatus(m) === "running")) ensureTicker();
        else renderWidget();
    });

    // Tear down the timer and clear the widget when the session ends.
    pi.on("session_shutdown", async (_event, ctx) => {
        stopTicker();
        try { ctx.ui.setWidget("subagents", []); } catch { /* ignore */ }
    });
}
