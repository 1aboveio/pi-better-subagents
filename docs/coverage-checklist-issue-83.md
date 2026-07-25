## Coverage Checklist — Issue #83

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows are auto-filled by `coverage-checklist.mjs generate`; lead/judgment rows are completed by the reviewer. A PASS/FAIL row with no locator, or a gate row left TODO, fails `coverage-checklist.mjs validate`._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | N/A | no browser route inventory / gen-inventory in this pi extension repo (`package.json` is extension-only) |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | PASS | `tests/subagent_spawn_batch.test.mjs` `@covers subagent-spawn-batch.*` `@level unit`; `tests/batch_spawn_end_to_end.test.mjs` `@covers subagent-spawn-batch.end-to-end` `@level integration`; `tests/subagent_list.test.mjs` batch display row |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | issue #83 ACs enumerate batch tool, option merging, normal runs, capacity, metadata, list output, validation, and compatibility; all addressed in `index.ts`, `batch.mjs`, `registry.ts`, `list.mjs` |
| Reachability/mutation classification is correct for changed surfaces | judgment | N/A | no HTTP/API routes; local extension tools only |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | command: `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --diff origin/main` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `git diff origin/main...HEAD` has no sleep/waitForTimeout |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | command: `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --diff origin/main` → 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/subagent_spawn_batch.test.mjs` asserts merge, validation, planning, formatting, names, and source wiring; `tests/batch_spawn_end_to_end.test.mjs` asserts real launches, capacity rejection, partial launch, and metadata fields |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | PASS | `@level unit` on pure helpers / source wiring, `@level integration` on the end-to-end fake-pi spawn test — appropriate floor for an extension tool surface |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | no browser / Playwright tests in diff |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance: PR-lane (new) AND whole-tree (inherited); no `@mock-ok` waiver; resolve by making it real, faking the external, or DELETING the test (over-mock is worse than no test); a false positive is fixed by correcting topology in coverage.config.json | gate-lint | PASS | command: `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules mock-internal-seam --diff origin/main` → 0 findings; `tests/batch_spawn_end_to_end.test.mjs` fakes only the external `pi` binary, not internal seams |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | N/A | no mocks of auth/money seams; end-to-end test spawns a real process via `spawnDetached` |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | `tests/batch_spawn_end_to_end.test.mjs:170-178` asserts the batch response text contains run ids and that each meta has batchId/batchName; no DOM/page assertions |
| Every new branch / error path has a driving test | lead | PASS | `tests/subagent_spawn_batch.test.mjs:47-120` covers validation errors; `tests/subagent_spawn_batch.test.mjs:177-215` covers capacity reject and launch-available; `tests/batch_spawn_end_to_end.test.mjs:176-246` covers end-to-end capacity, partial launch, and single-spawn compatibility |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | intended change is the additive batch tool; existing `subagent_spawn` behavior is preserved by reusing the same `spawnSubagentRun` helper and is asserted in `tests/batch_spawn_end_to_end.test.mjs` |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded (boots, no 500/crash on first call) — green tests alone do not prove the thing runs; browser surfaces use the presentation sweep instead | gate-lint | PASS | command: `node --test tests/*.test.mjs` (127 pass); `tests/batch_spawn_end_to_end.test.mjs` exercises the real `subagent_spawn_batch` tool path with a fake `pi` binary and verifies it returns run ids + writes metadata |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | no browser routes in this extension |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | no browser routes |
| Sweep specs do not intercept first-party traffic | lead | N/A | no browser routes |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | no browser routes |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | N/A | this repo's CI predates the ensure-coverage gate contract (`.github/workflows/ci.yml` runs `node --test tests/*.test.mjs` only); no `coverage.config.json` exists. The unit/integration tests added here are wired into the existing CI job. |
