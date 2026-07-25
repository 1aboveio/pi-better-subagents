/**
 * Pure seams for the minimal TUI subagent navigator (issue #45).
 *
 * Kept free of pi / pi-tui imports (mirrors widget.mjs) so unit tests pin the
 * behavior contracts without a live TUI. index.ts injects the pi-specific
 * pieces (matchesKey, truncateToWidth, CustomEditor, ctx) at the boundary.
 *
 * The navigator is a HUMAN organization surface: it reads the #44 registry
 * visibility seams (`navigatorVisibleRuns` / `navigatorVisibleCount`) and never
 * mutates run state. The passive live widget is untouched by this module.
 */

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
 * True only when a UI-bearing (TUI) context is available. Every navigator
 * entry point is gated on this so print/RPC sessions stay untouched.
 */
export function isNavigatorUiAvailable(ctx) {
    return Boolean(ctx && ctx.hasUI === true && ctx.ui);
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
    lines.push("↑↓ select · esc close");
    return lines.map((l) => truncate(l, width));
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
    const fg = (color, s) =>
        theme && typeof theme.fg === "function" ? theme.fg(color, s) : s;
    return {
        render(width) {
            const lines = buildNavigatorLines(state, { width, truncate: deps.truncate });
            return lines.map((line, i) => {
                if (i === 0) return fg("accent", line);
                if (i === lines.length - 1) return fg("dim", line);
                if (rows.length > 0 && i === 1 + state.selected) return fg("accent", line);
                return line;
            });
        },
        handleInput(data) {
            if (deps.matchKey(data, "up")) {
                if (moveSelection(state, -1)) tui.requestRender();
            } else if (deps.matchKey(data, "down")) {
                if (moveSelection(state, 1)) tui.requestRender();
            } else if (deps.matchKey(data, "escape")) {
                done(null);
            }
            // Anything else is ignored: the list view owns no other keys in #45.
        },
        invalidate() {
            // Stateless render — nothing cached to clear on theme changes.
        },
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
