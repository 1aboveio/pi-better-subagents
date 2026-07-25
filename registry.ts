/**
 * Run registry — durable metadata for each spawned subagent.
 *
 * The authoritative record for every run is a `meta.json` sidecar on disk, so
 * `list` / `output` / `result` keep working across foreground turns, `/reload`,
 * and even a full pi restart. In-memory state holds only the live exit handlers
 * for runs this process spawned.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processExists } from "./spawn.ts";

/**
 * Terminal + live statuses as recorded on disk. `orphaned` is durable and
 * NON-terminal (supervision broke, but related processes may still be alive);
 * `lost` is durable and terminal (no related process evidence remains).
 */
export type RunStatus = "running" | "completed" | "failed" | "killed" | "orphaned" | "lost";

/**
 * True when coherent child-exit evidence may finalize a run in this status.
 * `running` is the normal path; `orphaned`/`lost` are PROVISIONAL
 * reconciliation verdicts (a health tick can observe the just-exited pid
 * before the close handler runs) that the real exit — the stronger evidence —
 * supersedes. True terminal records are never overwritten: finalization is
 * idempotent (`completed`/`failed`) and a deliberate `subagent_stop` kill
 * (`killed`) is not undone by the resulting exit.
 */
export function canExitFinalize(status: RunStatus): boolean {
    return status === "running" || status === "orphaned" || status === "lost";
}

export interface RunMeta {
    id: string;
    name?: string;
    status: RunStatus;
    /** Child process PID. */
    pid: number;
    /** Child's process group id, captured at spawn where available (#63). */
    pgid?: number;
    /**
     * Opaque process-start identity token captured at spawn where available
     * (#63). Only equality is meaningful: a different token means the pid was
     * recycled by an unrelated process.
     */
    pidStartTime?: string;
    /** Consecutive pid-gone health ticks with no related evidence (old metadata). */
    probeMisses?: number;
    /** When supervision was observed broken (transition to `orphaned`). */
    orphanedAt?: number;
    /** When the last related process evidence disappeared (transition to `lost`). */
    lostAt?: number;
    /** PID of the pi process that launched this run (for cross-restart ownership). */
    spawnPid: number;
    model?: string;
    cwd: string;
    /** First ~200 chars of the task prompt, for listings. */
    promptPreview: string;
    startedAt: number;
    endedAt?: number;
    exitCode?: number | null;
    /** Why an otherwise-zero exit is recorded as a non-success. */
    failureReason?: "incomplete-stream";
    logPath: string;
    sessionId: string;
    /** Writable dir the child is OS-sandboxed to, if any. */
    sandbox?: string;
    /** Whether completion posts the result back to the main session (default true). */
    callback?: boolean;
    /** Batch ID for runs launched via subagent_spawn_batch. */
    batchId?: string;
    /** Optional batch display name. */
    batchName?: string;
}

/** Root runtime dir, deliberately OUTSIDE any repo. */
export function baseDir(): string {
    return join(tmpdir(), "pi-better-subagents");
}
export function sessionsDir(): string {
    return join(baseDir(), "sessions");
}
export function runDir(id: string): string {
    return join(baseDir(), "runs", id);
}
export function logPathFor(id: string): string {
    return join(runDir(id), "output.log");
}
export function promptPathFor(id: string): string {
    return join(runDir(id), "prompt.md");
}
function metaPathFor(id: string): string {
    return join(runDir(id), "meta.json");
}

let seq = 0;
/** Monotonic, readable, collision-free run id: `sa_<base36-time>_<seq>`. */
export function nextRunId(): string {
    seq += 1;
    return `sa_${Date.now().toString(36)}_${seq}`;
}

export function writeMeta(meta: RunMeta): void {
    mkdirSync(runDir(meta.id), { recursive: true });
    writeFileSync(metaPathFor(meta.id), JSON.stringify(meta, null, 2));
}

export function readMeta(id: string): RunMeta | undefined {
    try {
        return JSON.parse(readFileSync(metaPathFor(id), "utf-8")) as RunMeta;
    } catch {
        return undefined;
    }
}

/** All runs, newest first. */
export function listMetas(): RunMeta[] {
    let ids: string[];
    try {
        ids = readdirSync(join(baseDir(), "runs"));
    } catch {
        return [];
    }
    return ids
        .map(readMeta)
        .filter((m): m is RunMeta => m !== undefined)
        .sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Reconcile the recorded status with reality for display. A run marked
 * "running" whose PID is no longer alive exited without our handler firing
 * (foreground pi was closed / restarted) — surface that as "exited".
 */
export function effectiveStatus(meta: RunMeta): RunStatus | "exited" {
    if (meta.status !== "running") return meta.status;
    if (processExists(meta.pid)) return "running";
    return "exited";
}

/**
 * True when a status can yield a FINAL result: everything except `running`
 * and the non-terminal `orphaned`. `lost` is terminal (best-available
 * artifacts, never a completion); `exited` keeps its historic resultable
 * treatment. Used by subagent_result's gate.
 */
export function isFinalResultStatus(status: RunStatus | "exited"): boolean {
    return status !== "running" && status !== "orphaned";
}

/** True when this meta was spawned by the given parent pi PID (default: this process). */
export function ownedByThisParent(
    meta: Pick<RunMeta, "spawnPid">,
    parentPid: number = process.pid,
): boolean {
    return meta.spawnPid === parentPid;
}
