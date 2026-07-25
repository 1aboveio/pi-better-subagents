/**
 * Regression tests for child exits that occur before a coherent terminal event.
 *
 * // @covers subagent.run-finalization
 * // @level unit
 * // @fails-without-fix subagent.run-finalization
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyChildExit } from "../lifecycle.ts";

const coherentRun = {
    finalText: "Final answer",
    lastActivity: "Final answer",
    toolCalls: ["read"],
    unmatchedToolCalls: [],
    sawEnd: true,
    usage: { input: 0, output: 0, cacheRead: 0, costUSD: 0, total: 0 },
};

describe("classifyChildExit", () => {
    // @covers subagent.run-finalization
    // @level unit
    // @fails-without-fix subagent.run-finalization
    it("does not complete an exit-0 child with no terminal event", () => {
        const outcome = classifyChildExit(0, { ...coherentRun, sawEnd: false });

        assert.equal(outcome.status, "failed");
        assert.equal(outcome.incomplete, true);
        assert.doesNotMatch(outcome.verdict, /completed/i);
    });

    // @covers subagent.run-finalization
    // @level unit
    // @fails-without-fix subagent.run-finalization
    it("does not complete an exit-0 child with an unmatched tool execution", () => {
        const outcome = classifyChildExit(0, {
            ...coherentRun,
            unmatchedToolCalls: [{ id: "call_bash", toolName: "bash" }],
        });

        assert.equal(outcome.status, "failed");
        assert.equal(outcome.incomplete, true);
        assert.match(outcome.verdict, /incomplete/i);
    });

    // @covers subagent.run-finalization
    // @level unit
    it("completes an exit-0 child with coherent terminal evidence", () => {
        const outcome = classifyChildExit(0, coherentRun);

        assert.equal(outcome.status, "completed");
        assert.equal(outcome.incomplete, false);
        assert.match(outcome.verdict, /completed/i);
    });

    // @covers subagent.run-finalization
    // @level unit
    // @characterizes subagent.run-finalization
    it("preserves failed classification for a nonzero child exit", () => {
        const outcome = classifyChildExit(1, coherentRun);

        assert.equal(outcome.status, "failed");
        assert.equal(outcome.incomplete, false);
        assert.match(outcome.verdict, /failed/i);
    });
});
