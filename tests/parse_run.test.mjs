/**
 * Event-stream parsing regression coverage.
 *
 * // @covers subagent.run-log-parser
 * // @level unit
 * // @fails-without-fix subagent.run-log-parser
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    appendFileSync,
    closeSync,
    mkdirSync,
    openSync,
    rmSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import {
    LIFECYCLE_RECORD_PREFIX_BYTES,
    LIFECYCLE_SCAN_CHUNK_BYTES,
    parseRun,
    parseRunForLifecycle,
    scanLifecycleEvidence,
} from "../parse.ts";
import { logPathFor, runDir } from "../registry.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function withLog(id, events, run) {
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(logPathFor(id), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    try {
        run();
    } finally {
        rmSync(runDir(id), { recursive: true, force: true });
    }
}

/** Write a single oversized newline-free NDJSON record without retaining the payload in JS. */
function writeLargeNewlineFreeRecord(id, { type, toolCallId, toolName, payloadBytes }) {
    mkdirSync(runDir(id), { recursive: true });
    const path = logPathFor(id);
    const fd = openSync(path, "w");
    try {
        const headParts = [`"type":"${type}"`];
        if (toolCallId) headParts.push(`"toolCallId":"${toolCallId}"`);
        if (toolName) headParts.push(`"toolName":"${toolName}"`);
        const head = `{${headParts.join(",")},"payload":"`;
        writeSync(fd, head);
        const chunk = Buffer.alloc(64 * 1024, 0x78); // 'x'
        let remaining = payloadBytes;
        while (remaining > 0) {
            const n = Math.min(chunk.length, remaining);
            writeSync(fd, chunk, 0, n);
            remaining -= n;
        }
        writeSync(fd, `"}\n`);
    } finally {
        closeSync(fd);
    }
}

describe("parseRun tool execution coherence", () => {
    // @covers subagent.run-log-parser
    // @level unit
    // @fails-without-fix subagent.run-log-parser
    it("retains only tool starts that have no matching end by tool call id", () => {
        const id = `sa_parse_${process.pid}_${Date.now()}`;
        withLog(id, [
            { type: "tool_execution_start", toolCallId: "call_bash", toolName: "bash" },
            { type: "tool_execution_start", toolCallId: "call_read", toolName: "read" },
            { type: "tool_execution_end", toolCallId: "call_read", toolName: "read" },
            { type: "agent_settled" },
        ], () => {
            const parsed = parseRun(id);

            assert.equal(parsed.sawEnd, true);
            assert.deepEqual(parsed.unmatchedToolCalls, [{ id: "call_bash", toolName: "bash" }]);
        });
    });

    // @covers subagent.run-log-parser
    // @level unit
    // @fails-without-fix subagent.run-log-parser
    it("matches id-less tool events by tool name", () => {
        const id = `sa_parse_idless_${process.pid}_${Date.now()}`;
        withLog(id, [
            { type: "tool_execution_start", toolName: "read" },
            { type: "tool_execution_end", toolName: "read" },
            { type: "agent_settled" },
        ], () => {
            const parsed = parseRun(id);

            assert.deepEqual(parsed.unmatchedToolCalls, []);
        });
    });

    // @covers subagent.run-log-parser
    // @level unit
    // @fails-without-fix subagent.run-log-parser
    it("recognizes agent_end as terminal evidence even when it has no messages payload", () => {
        const id = `sa_parse_terminal_${process.pid}_${Date.now()}`;
        withLog(id, [{ type: "agent_end" }], () => {
            const parsed = parseRun(id);

            assert.equal(parsed.sawEnd, true);
        });
    });

    // @covers subagent.run-log-parser
    // @level unit
    // @fails-without-fix subagent.run-log-parser
    it("scanLifecycleEvidence keeps unmatched starts outside the bounded parse tail", () => {
        const id = `sa_parse_lifecycle_scan_${process.pid}_${Date.now()}`;
        const original = process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES;
        mkdirSync(runDir(id), { recursive: true });
        const start = JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "call_bash",
            toolName: "bash",
        });
        const pad = `${"x".repeat(5000)}\n`;
        const end = JSON.stringify({ type: "agent_end" });
        writeFileSync(logPathFor(id), `${start}\n${pad}${end}\n`);
        process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES = "1024";

        try {
            const bounded = parseRun(id);
            assert.equal(bounded.sawEnd, true);
            assert.deepEqual(bounded.unmatchedToolCalls, []);
            assert.ok(bounded.diagnostics.some((d) => /truncated/i.test(d)));

            const evidence = scanLifecycleEvidence(id);
            assert.equal(evidence.complete, true);
            assert.equal(evidence.sawEnd, true);
            assert.deepEqual(evidence.unmatchedToolCalls, [{ id: "call_bash", toolName: "bash" }]);

            const authoritative = parseRunForLifecycle(id);
            assert.equal(authoritative.sawEnd, true);
            assert.deepEqual(authoritative.unmatchedToolCalls, [{ id: "call_bash", toolName: "bash" }]);
            // Result-facing fields remain bounded-tail safe.
            assert.ok(authoritative.diagnostics.some((d) => /truncated/i.test(d)));
        } finally {
            if (original !== undefined) process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES = original;
            else delete process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES;
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    // @covers subagent.run-log-parser
    // @level unit
    // @fails-without-fix subagent.run-log-parser
    it("extracts lifecycle fields from a single newline-free event larger than the scan chunk without retaining the payload", () => {
        const id = `sa_parse_large_nlfree_${process.pid}_${Date.now()}`;
        // Payload exceeds both the 64 KiB scan chunk and the retained record prefix.
        // 8 MiB is large enough that retaining leftover+chunk would blow a 16 MiB heap,
        // while remaining a memory-safe fixture (no multi-hundred-MB files checked in).
        const payloadBytes = 8 * 1024 * 1024;
        assert.ok(payloadBytes > LIFECYCLE_SCAN_CHUNK_BYTES);
        assert.ok(payloadBytes > LIFECYCLE_RECORD_PREFIX_BYTES);

        writeLargeNewlineFreeRecord(id, {
            type: "agent_end",
            payloadBytes,
        });

        try {
            // Functional correctness in-process.
            let evidence;
            assert.doesNotThrow(() => {
                evidence = scanLifecycleEvidence(id);
            });
            assert.equal(evidence.complete, true);
            assert.equal(evidence.sawEnd, true);
            assert.deepEqual(evidence.unmatchedToolCalls, []);
            assert.equal(evidence.diagnostics.length, 0);

            // Memory bound: a tight-heap child must survive the scan. The old
            // leftover+chunk concatenation retained ~payload and OOM'd here.
            const child = spawnSync(
                process.execPath,
                [
                    "--max-old-space-size=16",
                    "--experimental-strip-types",
                    "-e",
                    `
                    import { scanLifecycleEvidence } from ${JSON.stringify(new URL("../parse.ts", import.meta.url).href)};
                    const evidence = scanLifecycleEvidence(${JSON.stringify(id)});
                    if (!evidence.complete || !evidence.sawEnd) {
                        console.error(JSON.stringify(evidence));
                        process.exit(2);
                    }
                    console.log("SCAN_OK");
                    `,
                ],
                {
                    cwd: REPO_ROOT,
                    encoding: "utf-8",
                    env: process.env,
                },
            );
            assert.equal(
                child.status,
                0,
                `tight-heap scan must exit 0, got ${child.status}\nstdout=${child.stdout}\nstderr=${child.stderr}\nsignal=${child.signal}`,
            );
            assert.match(child.stdout, /SCAN_OK/);
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    // @covers subagent.run-log-parser
    // @level unit
    // @fails-without-fix subagent.run-log-parser
    it("fails closed when an oversized newline-free record has no extractable lifecycle type", () => {
        const id = `sa_parse_large_unknown_${process.pid}_${Date.now()}`;
        mkdirSync(runDir(id), { recursive: true });
        const fd = openSync(logPathFor(id), "w");
        try {
            // JSON object whose "type" key appears only after the retained prefix bound.
            writeSync(fd, `{"payload":"`);
            const pad = Buffer.alloc(LIFECYCLE_RECORD_PREFIX_BYTES + 1024, 0x78);
            writeSync(fd, pad);
            writeSync(fd, `","type":"agent_end"}\n`);
        } finally {
            closeSync(fd);
        }

        try {
            const evidence = scanLifecycleEvidence(id);
            assert.equal(evidence.complete, false);
            assert.equal(evidence.sawEnd, false);
            assert.ok(evidence.diagnostics.some((d) => /capped oversized/i.test(d)));

            const authoritative = parseRunForLifecycle(id);
            // withLifecycleEvidence clears terminal evidence when complete:false.
            assert.equal(authoritative.sawEnd, false);
            assert.ok(authoritative.diagnostics.some((d) => /capped oversized/i.test(d)));
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    // @covers subagent.run-log-parser
    // @level unit
    // @fails-without-fix subagent.run-log-parser
    it("tracks unmatched tools from large newline-free tool_execution_start records", () => {
        const id = `sa_parse_large_tool_${process.pid}_${Date.now()}`;
        writeLargeNewlineFreeRecord(id, {
            type: "tool_execution_start",
            toolCallId: "call_bash",
            toolName: "bash",
            payloadBytes: LIFECYCLE_SCAN_CHUNK_BYTES * 2,
        });

        try {
            // Append a terminal event after the large start so terminal-in-tail is covered.
            appendFileSync(logPathFor(id), `${JSON.stringify({ type: "agent_end" })}\n`);

            const evidence = scanLifecycleEvidence(id);
            assert.equal(evidence.complete, true);
            assert.equal(evidence.sawEnd, true);
            assert.deepEqual(evidence.unmatchedToolCalls, [{ id: "call_bash", toolName: "bash" }]);
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
        }
    });
});
