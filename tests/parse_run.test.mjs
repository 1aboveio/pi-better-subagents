/**
 * Event-stream parsing regression coverage.
 *
 * // @covers subagent.run-log-parser
 * // @level unit
 * // @fails-without-fix subagent.run-log-parser
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { classifyChildExit } from "../lifecycle.ts";
import { parseRun } from "../parse.ts";
import { logPathFor, runDir } from "../registry.ts";

function withLog(id, events, run) {
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(logPathFor(id), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    try {
        run();
    } finally {
        rmSync(runDir(id), { recursive: true, force: true });
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
    it("keeps an unmatched start before the parse window when terminal evidence is in the tail", () => {
        const id = `sa_parse_bounded_coherence_${process.pid}_${Date.now()}`;
        const previousLimit = process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES;
        process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES = "256";
        try {
            withLog(id, [
                { type: "tool_execution_start", toolCallId: "call_before_window", toolName: "bash" },
                { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(1024) }] } },
                { type: "agent_settled" },
            ], () => {
                const parsed = parseRun(id);
                const outcome = classifyChildExit(0, parsed);

                assert.equal(parsed.sawEnd, true, "terminal evidence must still be detected from the tail");
                assert.deepEqual(parsed.unmatchedToolCalls, [{ id: "call_before_window", toolName: "bash" }]);
                assert.equal(outcome.status, "failed");
                assert.equal(outcome.incomplete, true);
            });
        } finally {
            if (previousLimit === undefined) delete process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES;
            else process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES = previousLimit;
        }
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
});
