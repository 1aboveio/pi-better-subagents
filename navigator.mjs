/**
 * Pure seams for the TUI subagent navigator (issues #45 list, #46 detail).
 *
 * Kept free of pi / pi-tui imports (mirrors widget.mjs) so unit tests pin the
 * behavior contracts without a live TUI. index.ts injects the pi-specific
 * pieces (matchesKey, truncateToWidth, CustomEditor, ctx, getDetail) at the
 * boundary.
 *
 * The navigator is a HUMAN organization surface: it reads the #44 registry
 * visibility seams (`navigatorVisibleRuns` / `navigatorVisibleCount`) and never
 * mutates run state. The passive live widget is untouched by this module.
 *
 * Detail view (#46) refreshes via an injected interval (default 1s) and must
 * dispose that timer on every exit path (back, Escape, overlay close, teardown).
 */

/** Detail-view refresh cadence (ms). Mirrors the live widget tick. */
export const DETAIL_TICK_MS = 1000;

/** Footer status key for the `← subagents · N` hint (default footer mechanism). */
export const NAVIGATOR_STATUS_KEY = "subagents-nav";

/**
 * Footer hint text: `← subagents · N` while at least one visible
 * current-parent run exists, null when none (caller clears the status).
 */
export function navigatorFooterHint(count) {
    return count > 0 ? `← subagents · ${count}` : null;
}

/**
 * Publish the footer hint through pi's default footer status mechanism.
 * Sets `← subagents · N` for count ≥ 1, clears the status at 0. Returns the
 * hint (or null) so callers can dirty-check. NEVER touches the footer itself.
 */
export function applyNavigatorFooter(ui, count) {
    const hint = navigatorFooterHint(count);
    ui.setStatus(NAVIGATOR_STATUS_KEY, hint ?? undefined);
    return hint;
}

/**
 * True only in an interactive TUI session with a UI present. Every navigator
 * entry point is gated on this so print/RPC sessions stay untouched.
 *
 * Pi exposes `hasUI: true` (and a `ui` object) in BOTH TUI and RPC modes
 * (extensions.md: `hasUI` guards dialog/notification methods that work in
 * both). The navigator uses terminal-only features — the `custom()` overlay
 * and the editor component factory — so the guard must require an explicit
 * `ctx.mode === "tui"` on top of UI availability; `hasUI` alone would leak
 * `setStatus`/`setEditorComponent`/`custom` calls into RPC sessions.
 */
export function isNavigatorUiAvailable(ctx) {
    return Boolean(ctx && ctx.mode === "tui" && ctx.hasUI === true && ctx.ui);
}

/**
 * Display rows for the navigator list. Input order is preserved — callers pass
 * `navigatorVisibleRuns(listMetas())`, which is newest first and already
 * excludes dismissed and foreign-parent runs (running AND terminal included).
 *
 * @param {Array<object>} metas - visible RunMeta records (newest first)
 * @param {object} deps
 * @param {(m: object) => string} deps.effectiveStatus - registry effectiveStatus
 * @param {(model?: string) => string} deps.shortModel - widget shortModel
 * @param {(ms: number) => string} deps.fmtElapsed - widget fmtElapsed
 * @param {(m: object) => string} deps.spendFor - spend summary or "" (e.g. fmtSpend(parseRun(id).usage))
 * @param {number} [deps.now]
 */
export function buildNavigatorRows(metas, deps) {
    const now = deps.now ?? Date.now();
    return metas.map((m) => ({
        id: m.id,
        name: m.name,
        status: deps.effectiveStatus(m),
        model: deps.shortModel(m.model),
        // Terminal runs freeze elapsed at endedAt; running runs tick to now.
        elapsed: deps.fmtElapsed((m.endedAt ?? now) - m.startedAt),
        spend: deps.spendFor(m) || "",
    }));
}

// ---------------------------------------------------------------------------
// Selection state
// ---------------------------------------------------------------------------

/** Navigator list state: the rows plus the selected index (starts at top). */
export function createNavigatorState(rows) {
    const state = { rows: rows ?? [], selected: 0 };
    clampSelection(state);
    return state;
}

/** Keep the selection inside the current row list. */
export function clampSelection(state) {
    if (state.rows.length === 0) state.selected = 0;
    else if (state.selected > state.rows.length - 1) state.selected = state.rows.length - 1;
    else if (state.selected < 0) state.selected = 0;
    return state.selected;
}

/**
 * Move the selection by delta (−1 up, +1 down), clamped at both ends.
 * Returns true when the selection actually changed (callers repaint then).
 */
export function moveSelection(state, delta) {
    const before = state.selected;
    state.selected = Math.min(
        Math.max(state.selected + delta, 0),
        Math.max(0, state.rows.length - 1),
    );
    return state.selected !== before;
}

// ---------------------------------------------------------------------------
// List rendering
// ---------------------------------------------------------------------------

/**
 * Plain-text navigator lines: title, one `> `/`  `-prefixed line per row, and
 * a help line. Every line is passed through `opts.truncate(line, width)` so the
 * TUI width contract (no line wider than `width`) holds at the seam; index.ts
 * injects pi-tui's ANSI-safe truncateToWidth. Theme styling is applied by the
 * overlay component AFTER truncation, so visible width is preserved.
 */
export function buildNavigatorLines(state, opts = {}) {
    const width = opts.width ?? 80;
    const truncate = opts.truncate ?? ((s) => s);
    const rows = state.rows ?? [];
    const lines = [`Subagents · ${rows.length}`];
    if (rows.length === 0) {
        lines.push("  (no visible subagent runs)");
    }
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const prefix = i === state.selected ? "> " : "  ";
        const parts = [r.name ?? r.id, r.status, r.model, r.elapsed];
        if (r.spend) parts.push(r.spend);
        lines.push(prefix + parts.join(" · "));
    }
    lines.push("↑↓ select · enter open · esc close");
    return lines.map((l) => truncate(l, width));
}

// ---------------------------------------------------------------------------
// Detail view (issue #46)
// ---------------------------------------------------------------------------

/**
 * Assemble a detail snapshot for one run. All I/O lives behind deps so the
 * seam stays unit-testable; index.ts wires readMeta/parseRun/fmt*.
 *
 * @param {string} id
 * @param {object} deps
 * @param {(id: string) => object|undefined} deps.readMeta
 * @param {(m: object) => string} deps.effectiveStatus
 * @param {(id: string) => { finalText: string, lastActivity: string, toolCalls: string[], usage: object }} deps.parseRun
 * @param {(model?: string) => string} deps.shortModel
 * @param {(ms: number) => string} deps.fmtElapsed
 * @param {(u: object) => string} deps.fmtSpend
 * @param {number} [deps.now]
 * @returns {object|null} detail fields, or null when the run is unknown
 */
export function buildNavigatorDetail(id, deps) {
    const meta = deps.readMeta(id);
    if (!meta) return null;
    const now = deps.now ?? Date.now();
    const parsed = deps.parseRun(id);
    const toolCalls = parsed.toolCalls ?? [];
    const status = deps.effectiveStatus(meta);
    const running = status === "running";
    return {
        id: meta.id,
        name: meta.name,
        status,
        model: deps.shortModel(meta.model),
        elapsed: deps.fmtElapsed((meta.endedAt ?? now) - meta.startedAt),
        tools: toolCalls.length ? toolCalls.join(", ") : "",
        // Only a live run has a "current" tool (the latest invocation).
        currentTool: running && toolCalls.length ? toolCalls[toolCalls.length - 1] : undefined,
        spend: deps.fmtSpend(parsed.usage) || "",
        // Terminal prefers the final answer; running shows the live activity.
        output: (running ? (parsed.lastActivity || parsed.finalText) : (parsed.finalText || parsed.lastActivity)) || "",
    };
}

/**
 * Plain-text detail lines. Truncated BEFORE any theme styling (callers style
 * after), so visible width never exceeds `width`.
 */
export function buildDetailLines(detail, opts = {}) {
    const width = opts.width ?? 80;
    const truncate = opts.truncate ?? ((s) => s);
    if (!detail) {
        return ["(run unavailable)", "← back · esc close"].map((l) => truncate(l, width));
    }
    const title = detail.name || detail.id || "?";
    const lines = [];
    lines.push(title);
    lines.push(`status  ${detail.status ?? "?"}`);
    lines.push(`model   ${detail.model ?? "?"}`);
    lines.push(`elapsed ${detail.elapsed ?? "?"}`);
    // Prefer "current" while running; fall back to the full used-tools list.
    const toolsLabel = detail.currentTool
        ? `current ${detail.currentTool}`
        : (detail.tools ? `tools   ${detail.tools}` : "tools   (none)");
    lines.push(toolsLabel);
    lines.push(detail.spend ? `spend   ${detail.spend}` : "spend   (none)");
    lines.push("output");
    const body = detail.output && String(detail.output).trim() ? String(detail.output) : "(no output yet)";
    // Split multi-line output; each physical line is truncated independently.
    for (const raw of body.split(/\r?\n/)) {
        lines.push(raw.length ? raw : " ");
    }
    lines.push("← back · esc close");
    return lines.map((l) => truncate(l, width));
}

/** Keep selection on `id` when still present; otherwise clamp. */
export function selectById(state, id) {
    if (id == null) {
        clampSelection(state);
        return state.selected;
    }
    const idx = (state.rows ?? []).findIndex((r) => r && r.id === id);
    state.selected = idx >= 0 ? idx : state.selected;
    return clampSelection(state);
}

// ---------------------------------------------------------------------------
// Overlay component (opened via ctx.ui.custom(..., { overlay: true }))
// ---------------------------------------------------------------------------

/**
 * Build the custom component pi renders as the focused navigator overlay.
 *
 * @param {Array<object>} rows - buildNavigatorRows output (newest first)
 * @param {object} deps
 * @param {(data: string, keyId: string) => boolean} deps.matchKey - pi-tui matchesKey
 * @param {(s: string, w: number) => string} deps.truncate - pi-tui truncateToWidth
 * @param {object} tui - pi TUI (requestRender)
 * @param {object} [theme] - pi theme (fg); optional in tests
 * @param {(v: null) => void} done - pi close callback
 */
export function createNavigatorOverlayComponent(rows, deps, tui, theme, done) {
    const state = createNavigatorState(rows);
    /** @type {'list' | 'detail'} */
    let mode = "list";
    /** @type {object|null} */
    let detail = null;
    /** @type {string|null} id of the run currently shown in detail */
    let detailId = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    let detailTimer = null;
    let closed = false;

    const setIntervalFn = deps.setInterval ?? globalThis.setInterval.bind(globalThis);
    const clearIntervalFn = deps.clearInterval ?? globalThis.clearInterval.bind(globalThis);
    const tickMs = deps.tickMs ?? DETAIL_TICK_MS;

    const fg = (color, s) =>
        theme && typeof theme.fg === "function" ? theme.fg(color, s) : s;

    function stopDetailTimer() {
        if (detailTimer != null) {
            try { clearIntervalFn(detailTimer); } catch { /* ignore */ }
            detailTimer = null;
        }
    }

    function loadDetail(id) {
        if (typeof deps.getDetail !== "function") return null;
        try {
            return deps.getDetail(id) ?? null;
        } catch {
            return null;
        }
    }

    function enterDetail() {
        if (state.rows.length === 0) return;
        const row = state.rows[state.selected];
        if (!row) return;
        detailId = row.id;
        detail = loadDetail(detailId) ?? {
            id: detailId,
            name: row.name,
            status: row.status,
            model: row.model,
            elapsed: row.elapsed,
            spend: row.spend,
            tools: "",
            output: "",
        };
        mode = "detail";
        stopDetailTimer();
        // Refresh once per second while the detail view is open.
        detailTimer = setIntervalFn(() => {
            if (mode !== "detail" || detailId == null) return;
            detail = loadDetail(detailId) ?? detail;
            try { tui.requestRender(); } catch { /* ignore */ }
        }, tickMs);
        try { tui.requestRender(); } catch { /* ignore */ }
    }

    function leaveDetail() {
        if (mode !== "detail") return;
        const viewedId = detailId;
        stopDetailTimer();
        mode = "list";
        detail = null;
        detailId = null;
        // Optional live list refresh so a disappeared run can clamp cleanly.
        if (typeof deps.getRows === "function") {
            try {
                const next = deps.getRows();
                if (Array.isArray(next)) state.rows = next;
            } catch { /* keep prior rows */ }
        }
        selectById(state, viewedId);
        try { tui.requestRender(); } catch { /* ignore */ }
    }

    function close() {
        if (closed) return;
        closed = true;
        stopDetailTimer();
        mode = "list";
        detail = null;
        detailId = null;
        try { done(null); } catch { /* ignore */ }
    }

    function dispose() {
        // Session teardown / host overlay dismiss — always safe, idempotent.
        stopDetailTimer();
        mode = "list";
        detail = null;
        detailId = null;
    }

    return {
        render(width) {
            if (mode === "detail") {
                const lines = buildDetailLines(detail, { width, truncate: deps.truncate });
                return lines.map((line, i) => {
                    if (i === 0) return fg("accent", line);
                    if (i === lines.length - 1) return fg("dim", line);
                    return line;
                });
            }
            const lines = buildNavigatorLines(state, { width, truncate: deps.truncate });
            return lines.map((line, i) => {
                if (i === 0) return fg("accent", line);
                if (i === lines.length - 1) return fg("dim", line);
                if (state.rows.length > 0 && i === 1 + state.selected) return fg("accent", line);
                return line;
            });
        },
        handleInput(data) {
            if (closed) return;
            if (mode === "detail") {
                if (deps.matchKey(data, "left")) {
                    leaveDetail();
                } else if (deps.matchKey(data, "escape")) {
                    close();
                }
                // Detail owns no other keys in #46 (close/dismiss is #47).
                return;
            }
            if (deps.matchKey(data, "up")) {
                if (moveSelection(state, -1)) tui.requestRender();
            } else if (deps.matchKey(data, "down")) {
                if (moveSelection(state, 1)) tui.requestRender();
            } else if (deps.matchKey(data, "enter")) {
                enterDetail();
            } else if (deps.matchKey(data, "escape")) {
                close();
            }
            // Anything else is ignored in list view (#47 owns `x`).
        },
        invalidate() {
            // Stateless render — nothing cached to clear on theme changes.
        },
        /** Clear detail timers. Safe to call multiple times / after close. */
        dispose,
    };
}

/** Factory in the shape ctx.ui.custom expects: (tui, theme, keybindings, done). */
export function createNavigatorOverlayFactory(rows, deps) {
    return (tui, theme, _keybindings, done) =>
        createNavigatorOverlayComponent(rows, deps, tui, theme, done);
}

/**
 * Open the navigator as a focused overlay. `ui.custom(factory, { overlay: true })`
 * makes pi render it on top of existing content and focus it on show.
 */
export function showNavigator(ui, rows, deps) {
    return ui.custom(createNavigatorOverlayFactory(rows, deps), { overlay: true });
}

// ---------------------------------------------------------------------------
// Editor wrapper (empty-editor ← interception by composition)
// ---------------------------------------------------------------------------

/**
 * Wrap any editor component so bare ← on an EMPTY editor (with visible runs)
 * opens the navigator, and everything else delegates unchanged.
 *
 * Composition, not replacement: a delegating Proxy forwards every property get
 * (methods bound to the inner editor) and every set to the wrapped component,
 * so the duck-typing pi applies to whatever `setEditorComponent` produces
 * (onSubmit/onChange assignment, setText, borderColor, setPaddingX,
 * setAutocompleteProvider, the `actionHandlers` app-keybinding wiring) keeps
 * working against the inner editor.
 *
 * @param {object} inner - the wrapped editor component
 * @param {object} deps
 * @param {(data: string) => boolean} deps.isOpenTrigger - bare ← match (pi-tui matchesKey(data, Key.left))
 * @param {() => boolean} deps.canOpen - visible current-parent runs exist
 * @param {() => void} deps.onOpen - open the navigator overlay
 */
export function wrapEditor(inner, deps) {
    return new Proxy(inner, {
        get(target, prop) {
            if (prop === "handleInput") {
                return (data) => {
                    if (deps.isOpenTrigger(data) && target.getText() === "" && deps.canOpen()) {
                        deps.onOpen();
                        return;
                    }
                    target.handleInput(data);
                };
            }
            const v = Reflect.get(target, prop);
            return typeof v === "function" ? v.bind(target) : v;
        },
        set(target, prop, value) {
            return Reflect.set(target, prop, value);
        },
    });
}

/** String marks (not Symbols) so a RELOADED module instance recognizes a
 *  factory installed by its previous incarnation. */
export const NAVIGATOR_FACTORY_MARK = "__piBetterSubagentsNavigatorFactory";
const NAVIGATOR_FACTORY_REFRESH = "__piBetterSubagentsNavigatorRefresh";

/**
 * Install the navigator editor factory exactly once per UI.
 *
 * - No factory configured: wrap a default editor built by deps.createDefaultEditor.
 * - A factory from ANOTHER extension is configured: wrap its product (compose).
 * - Our own marked factory is already installed (repeat session_start, or a
 *   reloaded module seeing the previous incarnation's factory): refresh its
 *   deps and keep it — never stack a second wrapper.
 *
 * @param {object} ui - pi ctx.ui (getEditorComponent / setEditorComponent)
 * @param {object} deps - wrapEditor deps + createDefaultEditor(tui, theme, keybindings)
 * @returns the installed (or refreshed) factory
 */
export function installNavigatorEditor(ui, deps) {
    const prev = typeof ui.getEditorComponent === "function" ? ui.getEditorComponent() : undefined;
    if (prev && prev[NAVIGATOR_FACTORY_MARK] === true) {
        prev[NAVIGATOR_FACTORY_REFRESH](deps);
        return prev;
    }
    let currentDeps = deps;
    const base = prev;
    const factory = (tui, theme, keybindings) => {
        const inner = base
            ? base(tui, theme, keybindings)
            : currentDeps.createDefaultEditor(tui, theme, keybindings);
        return wrapEditor(inner, currentDeps);
    };
    factory[NAVIGATOR_FACTORY_MARK] = true;
    factory[NAVIGATOR_FACTORY_REFRESH] = (next) => {
        // Mutate in place: wrappers already built from this factory captured the
        // deps OBJECT, so refreshed callbacks must reach them too (a /reload
        // keeps the live editor instance alive).
        Object.assign(currentDeps, next);
    };
    ui.setEditorComponent(factory);
    return factory;
}
