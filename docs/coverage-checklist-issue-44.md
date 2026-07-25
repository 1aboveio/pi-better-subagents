## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows are auto-filled by `coverage-checklist.mjs generate`; lead/judgment rows are completed by the reviewer. A PASS/FAIL row with no locator, or a gate row left TODO, fails `coverage-checklist.mjs validate`._

Issue: #44 (durable navigator visibility + shared stop). Scope class: `surface-bearing` (`scope-class.mjs classify --stdin` over `070c145...HEAD` → "3 path(s) match no configured non-runtime pattern — index.ts, registry.ts, stop.ts").

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | PASS | `docs/tests/_generated/surface-inventory.json` regenerated with `registry.dismissal` (mutation), `registry.navigator-visibility` (read), `stop.shared` (mutation); no browser route manifest exists in this pi extension (precedent: `docs/coverage-checklist-issue-15.md`) |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | PASS | command: `node coverage-ledger.mjs validate` → "8 surfaces · 8 aligned · 0/8 tested surfaces over-mocked" — zero Missing/Orphan/Unrealized for the 3 #44 surfaces (owned by `docs/tests/issue-44-navigator-visibility-stop.coverage.yml`, proven by `tests/navigator_dismissal.test.mjs`); exit 1 is solely `Unverified` attestation rows (5 pre-existing #13 `widget.*`, identical at base `070c145`; 3 #44 rows a producer may not self-attest — awaiting reviewer promotion per ensure-coverage) |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | issue #44 ACs cover dismissal durability (AC1), visibility + footer count (AC2/AC3), id-based access (AC4), list stability (AC5), shared stop + stale reread (AC6/AC7); slice map in `docs/tests/issue-44-plan.md` — no other surfaces changed (`git diff 070c145...HEAD --name-only`: index.ts, registry.ts, stop.ts, tests + docs) |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | inventory classes: `registry.dismissal`=mutation (writes meta.json), `stop.shared`=mutation (signals process group + writes meta), `registry.navigator-visibility`=read (pure filter); local extension library seams, no HTTP/API routes |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff 070c14531ebcf5c9f88e4a333886a55d0c13926b` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff 070c14531ebcf5c9f88e4a333886a55d0c13926b` → 0 findings (`waitFor` in `tests/navigator_dismissal.test.mjs:78` is a bounded predicate poll, not a fixed sleep) |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --rules no-empty-test --diff 070c14531ebcf5c9f88e4a333886a55d0c13926b` → 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/navigator_dismissal.test.mjs` — 13 tests, all `assert.equal`/`assert.deepEqual`/`assert.throws` on observable outcomes (disk-persisted `dismissedAt`, visible-run id sets, footer counts, stop outcomes, killed status, process-group liveness); command: `node --test tests/navigator_dismissal.test.mjs` → 13/13 pass |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | PASS | `@level unit` tags in `tests/navigator_dismissal.test.mjs` match `requiredLevels: [unit]` in `docs/tests/issue-44-navigator-visibility-stop.coverage.yml`; `coverage-ledger.mjs validate` → 8 aligned, 0 Wrong-Level (residual exit-1 rows are `Unverified` attestation only — see breadth row) |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | no browser / Playwright tests in diff (`git diff 070c145...HEAD --name-only`) |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance: PR-lane (new) AND whole-tree (inherited); no `@mock-ok` waiver; resolve by making it real, faking the external, or DELETING the test (over-mock is worse than no test); a false positive is fixed by correcting topology in coverage.config.json | gate-lint | PASS | `lint-tests.mjs --rules mock-internal-seam --diff 070c145...` → 0 findings (PR lane); `lint-tests.mjs --rules mock-internal-seam` → 0 findings (whole-tree); `scan-diff.mjs` findings channel `[]` — no `vi.mock`/`jest.mock` anywhere; tests use the real tmpdir registry and a real detached `sleep 30` |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | N/A | no mocks at all; not a money/auth surface |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | assertions target durable disk state (`readMeta` re-reads), returned id sets/counts, `StopOutcome` values, and OS-level process liveness (`processExists`) — never implementation internals; command: `node --test tests/navigator_dismissal.test.mjs` |
| Every new branch / error path has a driving test | lead | PASS | `scan-diff.mjs` new-branch leads adjudicated: `stop.ts:31` unknown-id throw → "throws for an unknown run id"; `stop.ts:33` not-running → "refuses terminal runs without touching them" + stale-pid test; `registry.ts:135/136` dismissRun guards → "dismissRun is idempotent and returns undefined for unknown ids"; `index.ts:537` not-running branch → same stop.ts paths via delegation (output text identical by construction); test-helper branches in `waitFor`/`trackDisk` are harness, exercised by every async stop test |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | intended change declared: issue #44 AC6 (shared stop semantics). `index.ts` `subagent_stop` is a delegation-only refactor — the moved logic (unknown-id throw `Unknown run id: ${id}`, not-running status text, SIGTERM → killed + endedAt) lands verbatim in `stop.ts` and is pinned by the "shared stop behavior" tests in `tests/navigator_dismissal.test.mjs`; no pre-existing `subagent_stop` test existed at base `070c145` (grep of base `tests/` → no hits) |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded (boots, no 500/crash on first call) — green tests alone do not prove the thing runs; browser surfaces use the presentation sweep instead | gate-lint | PASS | `docs/tests/issue-44-runtime-smoke.json` → 4 surface(s), 0 fail; rerun: `node docs/tests/issue-44-runtime-smoke.mjs` (real tmpdir registry round-trip; real detached `sleep 30` SIGTERMed via process group; stale-pid not-running leaves record untouched; `node --experimental-strip-types --check index.ts` parses) |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | no browser routes in this pi extension (`git diff 070c145...HEAD --name-only` — no route/page files) |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | no browser routes |
| Sweep specs do not intercept first-party traffic | lead | N/A | no browser routes |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | no browser routes |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | PASS | `.github/workflows/ci.yml` runs the type-strip check + `node --test tests/*.test.mjs` on PRs (the gates applicable to this extension repo — no browser surfaces, so no sweep/e2e gates exist to wire; precedent: `docs/coverage-checklist-issue-15.md` enforcement row) |
