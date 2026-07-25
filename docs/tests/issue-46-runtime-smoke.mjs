/**
 * Runtime smoke for issue #46 — live detail view navigation.
 *
 * Exercises the changed non-browser surface for real (not via the test
 * harness): real tmpdir registry + log parse feeding buildNavigatorDetail,
 * Enter → live detail → tick refresh → running-to-terminal transition →
 * ← back (selection preserved) → Escape close with timer disposal, plus
 * narrow-width truncation. Pi's UI/timer are the external boundary and are
 * recorded with fakes (per #43's thin-wiring-seam testing decision);
 * everything on OUR side of the boundary is the shipping code.
 *
 * Rerun:  node docs/tests/issue-46-runtime-smoke.mjs > docs/tests/issue-46-runtime-smoke.json
 */
import { execFileSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
    writeMeta,
    readMeta,
    effectiveStatus,
    runDir,
    logPathFor,
} from "../../registry.ts";
import {
    buildNavigatorDetail,
    buildNavigatorRows,
    showNavigator,
    DETAIL_TICK_MS,
    isNavigatorUiAvailable,
} from "../../navigator.ts";
import { fmtElapsed, shortModel, fmtSpend } from "../../widget.ts";
import { parseRun } from "../../parse.ts";

const THIS_PID = process.pid;
const results = [];
const diskIds = [];

function trackDisk(id) {
    diskIds.push(id);
    return id;
}

function baseMeta(overrides = {}) {
    return {
        id: overrides.id,
        status: "completed",
        pid: 0,
        spawnPid: THIS_PID,
        cwd: "/tmp",
        promptPreview: "smoke46",
        startedAt: 1,
        logPath: "/tmp/smoke46.log",
        sessionId: "smoke46",
        ...overrides,
    };
}

function writeLog(id, events) {
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(
        logPathFor(id),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
}

function record(surface, command, fn) {
    return Promise.resolve()
        .then(fn)
        .then(
            (observed) => results.push({ surface, kind: "library", status: "pass", command, observed }),
            (err) =>
                results.push({
                    surface,
                    kind: "library",
                    status: "fail",
                    command,
                    observed: `FAIL: ${err?.message ?? err}`,
                }),
        );
}

function check(cond, msg) {
    if (!cond) throw new Error(msg);
}

function fakeTimers() {
    let nextId = 1;
    const intervals = new Map();
    return {
        intervals,
        setInterval(fn, ms) {
            const id = nextId++;
            intervals.set(id, { fn, ms });
            return id;
        },
        clearInterval(id) {
            intervals.delete(id);
        },
        tickAll() {
            for (const e of [...intervals.values()]) e.fn();
        },
        activeCount() {
            return intervals.size;
        },
    };
}

// 1. navigator.detail — real registry + parse → detail fields; overlay open →
//    enter → tick (running→terminal) → back (selection) → escape dispose.
await record(
    "navigator.detail",
    "node docs/tests/issue-46-runtime-smoke.mjs",
    async () => {
        const runId = trackDisk(`sa_smoke46_${Date.now()}`);
        const otherId = trackDisk(`sa_smoke46_o_${Date.now()}`);
        writeMeta(baseMeta({
            id: runId,
            name: "smoke-run",
            model: "xai/grok-4.5",
            status: "running",
            pid: THIS_PID,
            startedAt: Date.now() - 5000,
        }));
        writeMeta(baseMeta({
            id: otherId,
            name: "other",
            status: "completed",
            startedAt: Date.now() - 60_000,
            endedAt: Date.now() - 30_000,
        }));
        writeLog(runId, [
            { type: "tool_execution_start", toolName: "read" },
            { type: "tool_execution_start", toolName: "bash" },
            {
                type: "message_end",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "still working" }],
                    usage: { input: 100, output: 50, cost: { total: 0.001 } },
                },
            },
        ]);

        // Pure seam against real disk.
        const snap = buildNavigatorDetail(runId, {
            readMeta,
            effectiveStatus,
            parseRun,
            shortModel,
            fmtElapsed,
            fmtSpend,
        });
        check(snap && snap.status === "running", `status: ${snap?.status}`);
        check(snap.model === "grok-4.5", `model: ${snap.model}`);
        check(snap.tools.includes("bash"), `tools: ${snap.tools}`);
        check(snap.currentTool === "bash", `currentTool: ${snap.currentTool}`);
        check(snap.output.includes("still working"), `output: ${snap.output}`);
        check(!!snap.spend, `spend missing: ${snap.spend}`);
        check(!!snap.elapsed, `elapsed missing`);

        const rows = buildNavigatorRows(
            [readMeta(runId), readMeta(otherId)].filter(Boolean).sort((a, b) => b.startedAt - a.startedAt),
            {
                effectiveStatus,
                shortModel,
                fmtElapsed,
                spendFor: (m) => fmtSpend(parseRun(m.id).usage),
            },
        );
        check(rows.length === 2 && rows[0].id === runId, "newest-first rows");

        // Live overlay with injected timers.
        const timers = fakeTimers();
        let phase = "running";
        let renders = 0;
        const doneCalls = [];
        let customOptions;
        const ui = {
            custom(factory, options) {
                customOptions = options;
                const c = factory(
                    { requestRender: () => renders++ },
                    { fg: (_c, s) => s },
                    {},
                    (v) => doneCalls.push(v),
                );
                return Promise.resolve(c);
            },
        };
        const matchKey = (d, id) => d === `<${id}>`;
        const component = await showNavigator(ui, rows, {
            matchKey,
            truncate: (s, w) => (s.length > w ? s.slice(0, w) : s),
            getDetail: (id) => {
                if (id !== runId) {
                    return buildNavigatorDetail(id, {
                        readMeta, effectiveStatus, parseRun, shortModel, fmtElapsed, fmtSpend,
                    });
                }
                if (phase === "running") {
                    return buildNavigatorDetail(runId, {
                        readMeta, effectiveStatus, parseRun, shortModel, fmtElapsed, fmtSpend,
                    });
                }
                // Simulate terminal completion without reopening.
                return {
                    id: runId,
                    name: "smoke-run",
                    status: "completed",
                    model: "grok-4.5",
                    elapsed: "9s",
                    tools: "read, bash",
                    currentTool: undefined,
                    spend: "150 tok (↑100 ↓50) · $0.0010",
                    output: "final smoke answer",
                };
            },
            getRows: () => rows,
            setInterval: timers.setInterval,
            clearInterval: timers.clearInterval,
            tickMs: DETAIL_TICK_MS,
        });
        check(customOptions && customOptions.overlay === true, "must open focused overlay");

        // Select first row (runId) and open detail.
        component.handleInput("<enter>");
        check(timers.activeCount() === 1, "detail timer started");
        check([...timers.intervals.values()][0].ms === DETAIL_TICK_MS, "1s cadence");
        let text = component.render(80).join("\n");
        check(text.includes("smoke-run") && text.includes("running"), `detail open: ${text}`);
        check(text.includes("still working"), `live output: ${text}`);
        check(component.render(80).every((l) => l.length <= 80), "width 80 ok");

        // Running → terminal transition on tick.
        phase = "completed";
        const rendersBefore = renders;
        timers.tickAll();
        check(renders > rendersBefore, "tick repaints");
        text = component.render(80).join("\n");
        check(text.includes("completed") && text.includes("final smoke answer"), `transition: ${text}`);
        check(doneCalls.length === 0, "must not close on transition");
        check(timers.activeCount() === 1, "timer survives transition");

        // Narrow width.
        for (const w of [20, 37]) {
            for (const line of component.render(w)) {
                check(line.length <= w, `line exceeds ${w}: ${JSON.stringify(line)}`);
            }
        }

        // Back to list preserves selection.
        component.handleInput("<left>");
        check(timers.activeCount() === 0, "back disposes timer");
        const listLines = component.render(80);
        check(listLines.some((l) => l.startsWith("> ") && l.includes("smoke-run")), `selection: ${JSON.stringify(listLines)}`);
        check(doneCalls.length === 0, "back must not close");

        // Re-enter and Escape-close.
        component.handleInput("<enter>");
        check(timers.activeCount() === 1, "re-enter starts timer");
        component.handleInput("<escape>");
        check(doneCalls.length === 1 && doneCalls[0] === null, "escape closes");
        check(timers.activeCount() === 0, "escape disposes timer");

        // dispose is idempotent after close.
        if (typeof component.dispose === "function") component.dispose();
        check(timers.activeCount() === 0, "dispose after close stays clear");

        // Guard still TUI-only.
        check(isNavigatorUiAvailable({ mode: "rpc", hasUI: true, ui: {} }) === false, "rpc blocked");
        check(isNavigatorUiAvailable({ mode: "tui", hasUI: true, ui: {} }) === true, "tui allowed");

        return "real registry+parse detail fields; Enter→detail 1s timer; running→terminal on tick; ← back keeps selection + disposes; Escape closes + disposes; narrow width ok; dispose idempotent; TUI guard intact";
    },
);

// 2. index.ts — parses; detail wiring present (getDetail/dispose); no setFooter.
await record(
    "index.ts (extension entry)",
    "node --experimental-strip-types --check index.ts",
    () => {
        const repoRoot = path.dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
        execFileSync(process.execPath, ["--experimental-strip-types", "--check", "index.ts"], {
            cwd: repoRoot,
            stdio: "pipe",
        });
        const src = execFileSync(process.execPath, ["-e", "const fs=require('fs');process.stdout.write(fs.readFileSync('index.ts','utf8'))"], {
            cwd: repoRoot,
            encoding: "utf8",
        });
        check(src.includes("buildNavigatorDetail") || src.includes("navigatorDetail"), "detail builder wired");
        check(src.includes("getDetail"), "getDetail injected into showNavigator");
        check(src.includes("activeNavigatorDispose") || src.includes(".dispose"), "dispose tracked for teardown");
        check(!src.includes("setFooter"), "must not replace the full footer");
        const shutdownIdx = src.indexOf('pi.on("session_shutdown"');
        check(shutdownIdx >= 0, "session_shutdown exists");
        const shutdownBody = src.slice(shutdownIdx, src.indexOf("});", shutdownIdx) + 3);
        check(
            shutdownBody.includes("activeNavigatorDispose") || shutdownBody.includes("dispose"),
            "session_shutdown must dispose navigator detail timers",
        );
        return "index.ts parses; getDetail + dispose wired; session_shutdown disposes detail timers; no setFooter";
    },
);

for (const id of diskIds) {
    try {
        rmSync(runDir(id), { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
}

process.stdout.write(JSON.stringify(results, null, 2) + "\n");
const failed = results.filter((r) => r.status !== "pass");
if (failed.length > 0) {
    process.stderr.write(`runtime smoke: ${failed.length} surface(s) FAILED\n`);
    process.exit(1);
}
process.stderr.write(`runtime smoke: ${results.length} surfaces, 0 fail\n`);
