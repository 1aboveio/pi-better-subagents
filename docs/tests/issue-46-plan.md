# Issue #46 — Incremental plan (implement-and-pr step 4)

Unit: #46 Add live detail view navigation to the subagent navigator
Branch: issue-46-detail-subagent-navigator (stacked on origin/issue-45-minimal-subagent-navigator @ 5c9fb9d)
TDD: yes (AC-backed). RED first per slice, then GREEN.
Out of scope: #47 two-press close/dismiss, #48 docs/hardening (except #46 evidence docs).

## Slice map (AC → slice → surface → level)

| AC | Slice | Surface (@covers) | Level |
|----|-------|-------------------|-------|
| Enter on selected run opens detail view | S1: list→detail mode transition on enter | navigator.detail | unit |
| Detail shows effective status, model, elapsed, current/used tools, spend, parsed output | S2: `buildNavigatorDetail` + `buildDetailLines` pure seams | navigator.detail | unit |
| Detail refreshes once per second while open | S3: injectable interval; tick reloads detail + requestRender | navigator.detail | unit |
| Running detail transitions to terminal without close/reopen | S3: getDetail reread each tick; same view, new status/output | navigator.detail | unit |
| `←` in detail returns to list | S4: leaveDetail, stop timer, restore mode=list | navigator.detail | unit |
| Escape in detail closes navigator | S4: dispose + done(null) from detail mode | navigator.detail | unit |
| Returning to list preserves selection for viewed run when still visible | S4: selectById after optional getRows refresh | navigator.detail | unit |
| Detail timers disposed on back, Escape, overlay close, session teardown | S5: dispose() clears interval; done wrapper + index session_shutdown | navigator.detail | unit |
| Narrow terminal truncates safely | S2: every detail line through truncate(line, width) before style | navigator.detail | unit |
| Tests cover all of the above | `tests/navigator_detail.test.mjs` (+ #45 enter-key expectation update) | navigator.detail | unit |

## Notes

- Pure seams stay in `navigator.mjs` (no pi imports). Detail tick uses injected
  `setInterval`/`clearInterval`/`tickMs` so tests drive refresh without sleeps.
- `getDetail(id)` is the live-data seam (index.ts: readMeta + effectiveStatus +
  parseRun + fmtElapsed/fmtSpend/shortModel). Overlay never imports registry.
- Optional `getRows()` refreshes the list snapshot when leaving detail so a
  disappeared run can clamp selection sensibly.
- List help line gains `enter open`. Enter is no longer an ignored key (#45 test update).
- Active overlay `dispose()` is tracked in index.ts and invoked on session_shutdown
  (TUI-guarded path alongside existing navigator cleanup).
- Widget paths untouched. Non-TUI isolation unchanged (`isNavigatorUiAvailable`).
