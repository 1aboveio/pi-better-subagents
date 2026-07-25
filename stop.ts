/**
 * Shared stop semantics for subagent runs.
 *
 * `stopRun` is the single stop path used by BOTH the model-facing
 * `subagent_stop` tool and the TUI navigator close action (issues #44/#47), so
 * process-group termination and killed-status recording can never diverge
 * between the two surfaces.
 *
 * Race safety: the run's metadata and effective status are re-read from disk
 * at call time, never taken from a caller's cached copy. A run that finished
 * while a confirmation was pending is reported as not-running instead of
 * being "terminated" against stale state.
 */

import { readMeta, writeMeta, effectiveStatus } from "./registry.ts";
import { killProcessTree } from "./spawn.ts";

export type StopOutcome =
    | { action: "stopped"; id: string }
    | { action: "not-running"; id: string; status: string };

/**
 * Stop a run by id: SIGTERM its process group and record status "killed".
 *
 * Throws on an unknown id (same contract as the stop tool). When the run is
 * not effectively running, the on-disk record is left untouched — a stale
 * "running" status whose process already exited is reported, not rewritten.
 */
export function stopRun(id: string): StopOutcome {
    const meta = readMeta(id);
    if (!meta) throw new Error(`Unknown run id: ${id}`);
    const status = effectiveStatus(meta);
    if (status !== "running") return { action: "not-running", id, status };
    killProcessTree(meta.pid, "SIGTERM");
    meta.status = "killed";
    meta.endedAt = Date.now();
    writeMeta(meta);
    return { action: "stopped", id };
}
