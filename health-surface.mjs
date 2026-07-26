/**
 * Pure helpers that surface #66 health observations on existing list / output /
 * widget text without inventing a parallel health model (issue #67).
 *
 * Healthy/quiet stays low-noise. Degraded/actionable compact facts and durable
 * orphaned/lost statuses are the only additions.
 */

/** Statuses that are always actionable on list/output surfaces. */
const ACTIONABLE_STATUSES = new Set(["orphaned", "lost"]);

/** Age suffix from health-observation fmtAge: `10s`, `2m`, `1h5m`. */
const ORDINARY_TOOL_AGE = /^(?:\d+s|\d+m|\d+h\d+m)$/;

/**
 * Ordinary short-running open-tool label from #66: bare tool name, or name plus
 * a fmtAge duration. Degraded facts that merely share the tool-name prefix
 * (e.g. `model error` while a tool named `model` is running) must be kept.
 *
 * @param {string} fact
 * @param {string} toolName
 */
function isOrdinaryRunningToolFact(fact, toolName) {
    if (fact === toolName) return true;
    const prefix = `${toolName} `;
    if (!fact.startsWith(prefix)) return false;
    return ORDINARY_TOOL_AGE.test(fact.slice(prefix.length));
}

/**
 * #66 emits ordinary open-tool labels (e.g. `bash 10s`) in compactFacts before
 * long_running. Those are not degraded health for #67 surfaces — the widget
 * already shows the active tool via its normal label. Keep long_running and
 * every other compact fact.
 *
 * @param {{ compactFacts?: string[], tool?: { state?: string, active?: { toolName?: string } } }|null|undefined} obs
 * @returns {string[]}
 */
export function surfaceableCompactFacts(obs) {
    const facts = Array.isArray(obs?.compactFacts) ? obs.compactFacts : [];
    if (!obs || obs.tool?.state !== "running") {
        return facts.filter(Boolean);
    }
    const name = obs.tool?.active?.toolName;
    if (!name) return facts.filter(Boolean);
    // Drop only the ordinary running duration fact (`${name}` / `${name} 10s`).
    // Prefix-sharing degraded facts (`model error`, `model retrying`, …) stay.
    // long_running (`long ${name}…`) is retained because tool.state !== "running".
    return facts.filter((f) => f && !isOrdinaryRunningToolFact(f, name));
}

/**
 * True when the observation should add diagnostics beyond the compact baseline.
 * Quiet is intentionally silent — residual silence without residual stale /
 * phase warnings is not actionable noise for list/widget.
 * Ordinary tool.state === "running" compact facts are not actionable (#67).
 *
 * @param {{ status?: string, activity?: string, compactFacts?: string[], tool?: { state?: string, active?: { toolName?: string } } }|null|undefined} obs
 */
export function isActionableHealth(obs) {
    if (!obs) return false;
    if (ACTIONABLE_STATUSES.has(obs.status)) return true;
    if (obs.activity === "stale") return true;
    return surfaceableCompactFacts(obs).length > 0;
}

/**
 * Compact fact labels for degraded/actionable health, including process
 * liveness labels for orphaned/lost when compactFacts alone are empty.
 * Ordinary short-running tool labels are omitted (degraded-only contract).
 *
 * @param {{ status?: string, activity?: string, compactFacts?: string[], process?: { liveness?: string }, tool?: { state?: string, active?: { toolName?: string } } }|null|undefined} obs
 * @returns {string[]}
 */
export function healthSurfaceFacts(obs) {
    if (!obs) return [];
    const facts = [];
    if (obs.status === "orphaned") facts.push("orphaned");
    else if (obs.status === "lost") facts.push("lost");
    for (const f of surfaceableCompactFacts(obs)) {
        if (f && !facts.includes(f)) facts.push(f);
    }
    // Residual stale may already be in compactFacts; ensure it appears when
    // activity is stale and nothing more specific was listed.
    if (obs.activity === "stale" && !facts.some((f) => /\bstale\b/i.test(f))) {
        facts.push("stale");
    }
    return facts.slice(0, 3);
}

/**
 * Format list-row health suffix. Empty string when healthy/quiet so the row
 * stays on today's compact format.
 *
 * @param {{ status?: string, activity?: string, compactFacts?: string[] }|null|undefined} obs
 */
export function formatListHealthSuffix(obs) {
    if (!isActionableHealth(obs)) return "";
    const facts = healthSurfaceFacts(obs);
    // Orphaned/lost already appear in the status bracket; prefer remaining facts.
    const rest = facts.filter((f) => f !== obs.status);
    if (rest.length === 0) {
        // Still actionable via status alone — no extra suffix needed.
        return "";
    }
    return ` · ${rest.join(", ")}`;
}

/**
 * One-line health diagnostic for subagent_output / result heads.
 * Empty when healthy/quiet running.
 *
 * @param {{ status?: string, activity?: string, compactFacts?: string[] }|null|undefined} obs
 */
export function formatHealthDiagnosticLine(obs) {
    if (!isActionableHealth(obs)) return "";
    const facts = healthSurfaceFacts(obs);
    if (facts.length === 0) return "";
    return `[health: ${facts.join(", ")}]`;
}

/**
 * Short suffix for a passive widget run line. Empty for healthy/quiet so
 * geometry and text stay unchanged for quiet runs.
 *
 * @param {{ status?: string, activity?: string, compactFacts?: string[] }|null|undefined} obs
 */
export function formatWidgetHealthSuffix(obs) {
    if (!isActionableHealth(obs)) return "";
    const facts = healthSurfaceFacts(obs)
        // Widget already implies "running"; skip redundant process labels when
        // a more specific compact fact exists, but keep orphaned/lost alone.
        .filter((f) => f !== "running");
    if (facts.length === 0) return "";
    // Keep widget geometry mostly stable: at most two short tokens.
    return ` · ${facts.slice(0, 2).join(", ")}`;
}

/**
 * Append a health diagnostic line to an existing tool body when present.
 *
 * @param {string} body
 * @param {string} healthLine
 */
export function appendHealthDiagnostic(body, healthLine) {
    if (!healthLine) return body;
    // Place diagnostic just under the head line when body starts with `[id ·`.
    const nl = body.indexOf("\n");
    if (nl === -1) return `${body}\n${healthLine}`;
    return `${body.slice(0, nl)}\n${healthLine}${body.slice(nl)}`;
}
