/**
 * Pure formatter functions for subagent completion messages.
 * 
 * These functions produce lightweight messages that:
 * - callback=true (trigger): Signal completion and direct to subagent_result
 * - callback=false (quiet): Note completion without auto-posting
 * 
 * The actual result is NEVER embedded in the trigger message to avoid
 * double-display (model presents it AND it's embedded).
 */

/**
 * Format a callback trigger message for callback:true.
 * 
 * This is a SHORT message that:
 * - Announces the subagent finished
 * - Tells the model to call/use subagent_result id="<id>"
 * - Does NOT contain "--- result ---" or any result payload
 * - MAY include label, verdict, stat, and tools list
 * 
 * @param p.id - The run id
 * @param p.label - Human-readable label (e.g., "reviewer (abc123)")
 * @param p.verdict - Status line (e.g., "✓ completed" or "✗ failed (exit 1)")
 * @param p.stat - Statistics line (e.g., "45s · 1.2k tok · $0.0034")
 * @param p.tools - Optional tools used (e.g., "read,bash,web_fetch")
 */
export function formatCallbackTrigger(p) {
    const tools = p.tools ? ` ·${p.tools.replace(/\n/, " ")}` : "";
    return (
        `A background subagent you launched has returned.\n` +
        `subagent: ${p.label} · ${p.verdict} · ${p.stat}${tools}\n\n` +
        `Ingest this signal and call subagent_result id="${p.id}" to retrieve the actual result, ` +
        `then use/present it as appropriate.`
    );
}

/**
 * Format a quiet completion message for callback:false.
 * 
 * This message:
 * - Announces the subagent finished
 * - Explicitly states result is NOT auto-posted
 * - Directs to subagent_result for on-demand retrieval
 * 
 * @param p.id - The run id
 * @param p.label - Human-readable label
 * @param p.verdict - Status line
 * @param p.stat - Statistics line
 */
export function formatCallbackQuiet(p) {
    return (
        `Background subagent ${p.label} ${p.verdict} · ${p.stat}. ` +
        `Result NOT auto-posted (callback:false). ` +
        `Read it with subagent_result id="${p.id}" when wanted.`
    );
}

/**
 * Build the completion delivery from run outcome.
 *
 * This is the SINGLE place where sendMessage content and options are assembled.
 * `resultText` is accepted so callers can pass it without tests breaking, but
 * it is NEVER placed into `content` for either branch — the actual result is
 * always fetched via subagent_result, not embedded in the trigger/quiet message.
 *
 * @param p.id       - Run id
 * @param p.label    - Human-readable label
 * @param p.verdict  - Status line (e.g. "✓ completed")
 * @param p.stat     - Statistics line (e.g. "45s · 1.2k tok")
 * @param p.tools    - Optional tools list
 * @param p.callback - Whether to trigger a turn (true) or be quiet (false)
 * @param p.resultText - The parsed final answer; MUST NOT appear in content
 */
export function buildCompletionDelivery(p) {
    if (p.callback) {
        return {
            content: formatCallbackTrigger({
                id: p.id,
                label: p.label,
                verdict: p.verdict,
                stat: p.stat,
                tools: p.tools,
            }),
            options: { deliverAs: "followUp", triggerTurn: true },
        };
    }
    return {
        content: formatCallbackQuiet({
            id: p.id,
            label: p.label,
            verdict: p.verdict,
            stat: p.stat,
        }),
        options: { deliverAs: "nextTurn" },
    };
}
