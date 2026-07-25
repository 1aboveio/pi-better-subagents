/**
 * Incomplete child exits must remain diagnostics, not synthesized final answers.
 *
 * // @covers subagent.result
 * // @level unit
 * // @fails-without-fix subagent.result
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatIncompleteResult } from "../lifecycle.ts";

const incompleteRun = {
    finalText: "progress before exit",
    lastActivity: "progress before exit",
    toolCalls: ["bash"],
    unmatchedToolCalls: [{ id: "call_bash", toolName: "bash" }],
    sawEnd: false,
    usage: { input: 0, output: 0, cacheRead: 0, costUSD: 0, total: 0 },
};

describe("subagent_result for incomplete child exits", () => {
    // @covers subagent.result
    // @level unit
    // @fails-without-fix subagent.result
    it("returns best parsed output and a raw log tail instead of a normal result", () => {
        const rawTail = "RAW_INCOMPLETE_LOG_TAIL";
        const content = formatIncompleteResult(incompleteRun, rawTail);

        assert.match(content, /ended unexpectedly/i);
        assert.match(content, /progress before exit/);
        assert.match(content, /--- raw log tail ---/);
        assert.match(content, new RegExp(rawTail));
        assert.doesNotMatch(content, /completed/i);
    });

    // @covers subagent.result
    // @level unit
    it("is wired into the registered subagent_result tool", () => {
        // Handlers live in tools.ts; index.ts registers the factory result so the
        // model reaches the same execute path tests drive (no drift-prone copy).
        const toolsSource = readFileSync(new URL("../tools.ts", import.meta.url), "utf8");
        const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

        assert.match(toolsSource, /formatIncompleteResult/);
        assert.match(toolsSource, /failureReason === "incomplete-stream"/);
        assert.match(indexSource, /subagentResultTool\(Type\)/);
    });
});
