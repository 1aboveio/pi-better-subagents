import type { ParsedRun } from "./parse.ts";

export interface ChildExitOutcome {
    status: "completed" | "failed";
    incomplete: boolean;
    verdict: string;
}

/** Classify a child process exit before persisting its run metadata. */
export function classifyChildExit(code: number | null, run: ParsedRun): ChildExitOutcome {
    const exitedSuccessfully = code === 0 || code === null;
    const incomplete = exitedSuccessfully && (!run.sawEnd || run.unmatchedToolCalls.length > 0);
    const status = exitedSuccessfully && !incomplete ? "completed" : "failed";
    return {
        status,
        incomplete,
        verdict: incomplete
            ? `! incomplete child exit (exit ${code})`
            : status === "completed" ? "✓ completed" : `✗ failed (exit ${code})`,
    };
}

/** Render the evidence for a child that exited before producing a final answer. */
export function formatIncompleteResult(run: ParsedRun, rawLogTail: string): string {
    const evidence = [
        !run.sawEnd ? "no agent_end or agent_settled event" : "terminal event observed",
        run.unmatchedToolCalls.length
            ? `unmatched tools: ${run.unmatchedToolCalls.map((call) => `${call.toolName}${call.id ? ` (${call.id})` : ""}`).join(", ")}`
            : "no unmatched tools",
    ].join("; ");
    const bestAvailable = run.finalText || run.lastActivity || "(no parsed assistant output)";
    return [
        "Run ended unexpectedly before producing a coherent final result.",
        `Stream evidence: ${evidence}.`,
        "",
        "--- best available parsed output ---",
        bestAvailable,
        "",
        "--- raw log tail ---",
        rawLogTail,
    ].join("\n");
}
