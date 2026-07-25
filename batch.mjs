/**
 * Pure helpers for subagent_spawn_batch.
 *
 * Planning, option merging, validation, and response formatting live here so
 * they are unit-testable without mocking the spawn seam. The batch tool in
 * index.ts calls these helpers and then reuses the same internal spawn path
 * as subagent_spawn so behavior cannot drift.
 */

import { BUILTIN_TOOLS } from "./extensions.mjs";

const VALID_CAPACITY_MODES = new Set(["reject", "launch-available"]);

/**
 * Overlay per-job options on top of shared options. Only defined keys are
 * inherited; booleans keep their false values.
 */
export function mergeJobOptions(shared, job) {
    return {
        prompt: job.prompt,
        name: job.name ?? shared?.name,
        model: job.model ?? shared?.model,
        tools: job.tools ?? shared?.tools,
        exclude_tools: job.exclude_tools ?? shared?.exclude_tools,
        clean: job.clean ?? shared?.clean,
        sandbox: job.sandbox ?? shared?.sandbox,
        sandbox_dir: job.sandbox_dir ?? shared?.sandbox_dir,
        callback: job.callback ?? shared?.callback,
        cwd: job.cwd ?? shared?.cwd,
        approve: job.approve ?? shared?.approve,
        allow_nested: job.allow_nested ?? shared?.allow_nested,
    };
}

/**
 * Validate a batch plan before any job is launched. Throws a clear error for
 * malformed input or invalid option combinations.
 */
export function validateBatchPlan({ shared, jobs, onCapacity, config }) {
    if (!Array.isArray(jobs)) {
        throw new Error("jobs must be an array.");
    }
    if (jobs.length === 0) {
        throw new Error("jobs must contain at least one job.");
    }

    if (onCapacity !== undefined && !VALID_CAPACITY_MODES.has(onCapacity)) {
        throw new Error(
            `onCapacity must be "reject" or "launch-available"; got ${JSON.stringify(onCapacity)}.`,
        );
    }

    const seenPrompts = new Set();
    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (!job || typeof job !== "object") {
            throw new Error(`job ${i + 1} must be an object.`);
        }
        if (typeof job.prompt !== "string" || job.prompt.trim() === "") {
            throw new Error(`job ${i + 1} is missing a non-empty prompt.`);
        }
        if (seenPrompts.has(job.prompt)) {
            // Duplicate prompts are allowed, but a batch with every prompt
            // identical is a common mistake; warn via the error path only when
            // ALL prompts are the same (still launchable if intentional).
            if (i === jobs.length - 1 && seenPrompts.size === 1) {
                // Not a hard error; callers may choose to warn.
            }
        }
        seenPrompts.add(job.prompt);

        const merged = mergeJobOptions(shared, job);
        if (merged.clean === true) {
            if (merged.allow_nested === true) {
                throw new Error(
                    `job ${i + 1} (${merged.name ?? i + 1}): clean:true with allow_nested:true ` +
                        "is invalid — clean children load no extensions, so nested subagent tools cannot exist.",
                );
            }
            const toolList = merged.tools
                ? merged.tools.split(",").map((t) => t.trim()).filter(Boolean)
                : [];
            for (const tool of toolList) {
                if (!BUILTIN_TOOLS.includes(tool)) {
                    throw new Error(
                        `job ${i + 1} (${merged.name ?? i + 1}): clean:true with ` +
                            `extension-provided tool "${tool}" is invalid — the tool will not exist in a clean child.`,
                    );
                }
            }
        }
    }
}

/**
 * Assign a display name to every job.
 *   - missing name -> job-{index}
 *   - duplicate name -> name-2, name-3, ...
 */
export function assignBatchJobNames(jobs) {
    const counts = new Map();
    const names = [];

    for (let i = 0; i < jobs.length; i++) {
        const raw = jobs[i]?.name ?? `${BATCH_JOB_NAME_DEFAULT}-${i + 1}`;
        const count = (counts.get(raw) ?? 0) + 1;
        counts.set(raw, count);

        if (count === 1) {
            names.push(raw);
        } else {
            names.push(`${raw}-${count}`);
        }
    }

    return names;
}

export const BATCH_JOB_NAME_DEFAULT = "job";

let batchSeq = 0;
/** Generate a collision-free batch ID distinct from run IDs. */
export function nextBatchId() {
    batchSeq += 1;
    return `batch_${Date.now().toString(36)}_${batchSeq}`;
}

/**
 * Decide which jobs launch and which are skipped based on available capacity.
 *
 *   onCapacity === "reject" (default): throw if the whole batch does not fit.
 *   onCapacity === "launch-available": launch up to the available slots.
 */
export function planBatchLaunches({ jobs, runningCount, maxConcurrent, onCapacity }) {
    const available = Math.max(0, maxConcurrent - runningCount);

    if (onCapacity === "launch-available") {
        const toLaunch = jobs.slice(0, available);
        const skipped = jobs.slice(available);
        return { toLaunch, skipped };
    }

    if (jobs.length > available) {
        throw new Error(
            `Batch of ${jobs.length} jobs exceeds available capacity ` +
                `(${available}/${maxConcurrent} subagent slots free). ` +
                "Stop some runs or set onCapacity to \"launch-available\".",
        );
    }

    return { toLaunch: jobs, skipped: [] };
}

/**
 * Format the launch response for subagent_spawn_batch.
 */
export function formatBatchLaunchResponse({ batchId, batchName, launched, skipped }) {
    const lines = [];
    const label = batchName ? `${batchName} (${batchId})` : batchId;

    if (launched.length === 0) {
        lines.push(`Batch ${label}: no jobs launched — capacity full.`);
    } else {
        lines.push(
            `Batch ${label} launched ${launched.length} subagent(s):`,
        );
        for (const { name, id } of launched) {
            lines.push(`• ${name} → ${id}`);
        }
    }

    if (skipped.length) {
        lines.push(
            `Skipped (capacity): ${skipped.map((j) => j.name).join(", ")}`,
        );
    }

    return lines.join("\n");
}
