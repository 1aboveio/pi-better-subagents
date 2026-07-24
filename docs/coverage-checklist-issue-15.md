## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows are auto-filled by `coverage-checklist.mjs generate`; lead/judgment rows are completed by the reviewer. A PASS/FAIL row with no locator, or a gate row left TODO, fails `coverage-checklist.mjs validate`._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | TODO | _run_ gen-inventory + `git diff --exit-code` (CI gate 1) |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | TODO | _run_ `coverage-ledger.mjs validate` |
| No un-specced capability missed — the surfaces no AC mentions | judgment | TODO | _cite `file:line` + reasoning_ |
| Reachability/mutation classification is correct for changed surfaces | judgment | TODO | _cite `file:line` + reasoning_ |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --rules no-skip --diff origin/main` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff origin/main` → 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | TODO | _run_ `lint-tests.mjs --rules no-empty-test --diff <base>` |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | TODO | _adjudicate the lead — cite `file:line` + verdict_ |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | TODO | _run_ `coverage-ledger.mjs validate` |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | TODO | _adjudicate the lead — cite `file:line` + verdict_ |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance: PR-lane (new) AND whole-tree (inherited); no `@mock-ok` waiver; resolve by making it real, faking the external, or DELETING the test (over-mock is worse than no test); a false positive is fixed by correcting topology in coverage.config.json | gate-lint | TODO | _run_ `lint-tests.mjs --rules mock-internal-seam --diff <base>` (PR lane) + `lint-tests.mjs --rules mock-internal-seam` (whole-tree) |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | TODO | _cite `file:line` + reasoning_ |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | TODO | _cite `file:line` + reasoning_ |
| Every new branch / error path has a driving test | lead | TODO | _adjudicate the lead — cite `file:line` + verdict_ |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | TODO | _adjudicate the lead — cite `file:line` + verdict_ |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded (boots, no 500/crash on first call) — green tests alone do not prove the thing runs; browser surfaces use the presentation sweep instead | gate-lint | TODO | _run_ runtime-smoke results (`--smoke <results.json>`) |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | TODO | _run_ `coverage-ledger.mjs validate` |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | TODO | _run_ presentation-sweep results (e2e-test) |
| Sweep specs do not intercept first-party traffic | lead | TODO | _adjudicate the lead — cite `file:line` + verdict_ |
| Perceivability edge cases the instruments cannot score are checked | judgment | TODO | _cite `file:line` + reasoning_ |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | TODO | _run_ `ci-audit.mjs --files <ci>` |

