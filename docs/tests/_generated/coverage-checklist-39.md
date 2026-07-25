## Coverage Checklist — issue #39 (sandbox backend-selection prefactor)

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows are auto-filled by `coverage-checklist.mjs generate`; lead/judgment rows are completed by the reviewer. A PASS/FAIL row with no locator, or a gate row left TODO, fails `coverage-checklist.mjs validate`._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | PASS | `docs/tests/_generated/surface-inventory.json` gains `sandbox.backend-selection`, `sandbox.support-query`, `sandbox.command-wrapper`, `sandbox-profile`, `spawn.detached` (no gen-inventory adapter exists in this repo — inventory is hand-maintained JSON; no browser route manifest exists) |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | FAIL | `coverage-ledger.mjs validate` (exit 1) — 10 surfaces · 10 aligned · 0/10 over-mocked · 10 errors · 0 warnings. Decomposition: 0 Missing, 0 Orphan; all 10 errors are attestation-pending `Unverified` — 5 pre-existing `widget.*` on main (issue #13 leftovers) + 5 new issue-39 surfaces owned by `docs/tests/issue-39-sandbox-backend-selection.coverage.yml`, awaiting reviewer attestation per doctrine |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | #39 ACs enumerate seam, wrapper, support query, import-strict test; the diff adds no other runtime surface (`git diff origin/main`: `sandbox.ts` + tests + docs evidence only) |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | all 5 reachable via `index.ts`/tests; `sandbox.command-wrapper` + `spawn.detached` = mutation (profile write; child spawn + log write), selection/support-query/profile = read (`docs/tests/_generated/surface-inventory.json`) |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff origin/main` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff origin/main` → 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --rules no-empty-test --diff origin/main` → 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | wrapper argv `deepEqual` + byte-pinned SBPL profile (`tests/sandbox_wrapper_contract.test.mjs`); real child stdout/stderr in log + exit 0 + argv order (`tests/spawn_detached.test.mjs`); seam mapping darwin/linux/win32 + dispatch equality (`tests/sandbox_backend_selection.test.mjs`) |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | PASS | all 5 surfaces satisfy the unit floor statically (`coverage-ledger.mjs validate`: 10 aligned, 0% over-mocked); ledger errors are attestation-pending `Unverified`, not wrong-level — `@level unit` on every new test |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | no Playwright/browser tests in the diff; `grep -rn "page.route\|route.fulfill\|setupServer\|setupWorker\|msw" tests/` → no matches |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance: PR-lane (new) AND whole-tree (inherited); no `@mock-ok` waiver; resolve by making it real, faking the external, or DELETING the test (over-mock is worse than no test); a false positive is fixed by correcting topology in coverage.config.json | gate-lint | PASS | `lint-tests.mjs --rules mock-internal-seam --diff origin/main` → 0 findings; whole-tree `lint-tests.mjs --rules mock-internal-seam` → 0 findings; new tests import real `sandbox.ts` / `spawn.ts` |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | N/A | no mocks anywhere in the diff; not a money/auth/idempotency surface |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | assertions on real return values, real profile bytes, real child output; `tests/sandbox_profile.test.mjs` is import-strict so a load failure fails the file (proven: missing/throwing/syntax-broken `sandbox.ts` → exit 1) |
| Every new branch / error path has a driving test | lead | PASS | registry hit (darwin) vs miss (linux/win32) in `tests/sandbox_backend_selection.test.mjs`; `buildSandboxCommand` fallback path asserted in the same file (non-darwin branch); `realpathSync` try/catch preserved and exercised by `tests/sandbox_profile.test.mjs` + wrapper-contract tests |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | `@characterizes` tests GREEN on pre-change tree @070c145 (wrapper contract 3/3, spawn detached 2/2 — see PR RED/GREEN evidence); no intended behavior change declared |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded (boots, no 500/crash on first call) — green tests alone do not prove the thing runs; browser surfaces use the presentation sweep instead | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results-39.json` → 3 surface(s), 0 fail |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | no browser route in this extension; `scope-class.mjs classify` matched only docs+tests classes with `sandbox.ts` a runtime library path |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | no browser routes; presentation sweep inapplicable |
| Sweep specs do not intercept first-party traffic | lead | N/A | no sweep specs exist |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | no browser routes |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | FAIL | `ci-audit.mjs --files .github/workflows/ci.yml` → inventory/sweep/e2e/mock-seam/checklist/evidence-block/smoke gates absent — pre-existing repo state (the repo has not adopted the full ensure-coverage CI contract); #39 does not modify CI, and the existing `ci` PR gate (parse + `node --test tests/*.test.mjs`) remains blocking |
