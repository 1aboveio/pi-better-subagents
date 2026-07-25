import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { classifyChildExit } from "../lifecycle.ts";
import { parseRun } from "../parse.ts";
import { logPathFor, runDir } from "../registry.ts";

const id = `sa_smoke_midturn_${process.pid}_${Date.now()}`;
const previousLimit = process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES;
process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES = "256";
mkdirSync(runDir(id), { recursive: true });
writeFileSync(logPathFor(id), [
    JSON.stringify({ type: "tool_execution_start", toolCallId: "call_bash", toolName: "bash" }),
    JSON.stringify({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(1024) }] } }),
    JSON.stringify({ type: "agent_settled" }),
].join("\n"));

try {
    const parsed = parseRun(id);
    const outcome = classifyChildExit(0, parsed);
    assert.equal(parsed.sawEnd, true);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.incomplete, true);
    assert.equal(parsed.unmatchedToolCalls[0]?.toolName, "bash");
    console.log("SMOKE PASS: full-stream coherence rejects a bounded-tail exit-0 run");
} finally {
    if (previousLimit === undefined) delete process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES;
    else process.env.PI_SUBAGENT_MAX_LOG_PARSE_BYTES = previousLimit;
    rmSync(runDir(id), { recursive: true, force: true });
}
