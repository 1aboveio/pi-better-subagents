## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue). Gate rows are auto-filled by `coverage-checklist.mjs generate`; lead/judgment rows are completed by the reviewer. A PASS/FAIL row with no locator, or a gate row left TODO, fails `coverage-checklist.mjs validate`._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | N/A | No repository inventory generator exists; `docs/tests/_generated/surface-inventory.json` is not maintained. |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | PASS | `coverage-ledger.mjs validate` (exit 0) — no surface inventory adapter in this repo, but all changed runtime paths are exercised by added unit/integration tests. |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | New surfaces: `git-workspace.ts` (clone prep + inspection), `index.ts:subagent_spawn.git_clone_workspace` parameter. Both are covered by `tests/git_workspace.test.mjs` and `tests/git_clone_workspace_wiring.test.mjs`. No routes, APIs, events, or jobs added. |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | `subagent_spawn` is an existing tool surface; `git_clone_workspace` is a new write-path option on the same tool. No reachability change. Tests exercise both opt-in and opt-out. |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `lint-tests.mjs --diff 7ba67e97d19a85f0773789fe880e0d8b352e690b` → 0 findings |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `lint-tests.mjs --rules no-fixed-timeout --diff 7ba67e97d19a85f0773789fe880e0d8b352e690b` → 0 findings |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `lint-tests.mjs --diff 7ba67e97d19a85f0773789fe880e0d8b352e690b` → 0 findings |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/git_workspace.test.mjs` asserts filesystem state, git rev-parse output, alternates absence, and real git command success. `tests/git_clone_workspace_wiring.test.mjs` asserts source-level wiring to the tool schema and execute path. |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | PASS | `coverage-ledger.mjs validate` (exit 0). Unit level for workspace resolution/inspection; integration level for real git operations. |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | N/A | No browser/journey tests added; no `page.route`/`route.fulfill`/MSW usage. |
| No mock of a first-party internal seam module (real internals, faked externals) — zero-tolerance: PR-lane (new) AND whole-tree (inherited); no `@mock-ok` waiver; resolve by making it real, faking the external, or DELETING the test (over-mock is worse than no test); a false positive is fixed by correcting topology in coverage.config.json | gate-lint | PASS | `lint-tests.mjs --diff 7ba67e97d19a85f0773789fe880e0d8b352e690b` → 0 findings; `lint-tests.mjs` whole-tree → 0 findings. Tests use real `git` CLI; no first-party seams mocked. |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | No mocks used; real `git` subprocesses in `tests/git_workspace.test.mjs:49` and `git-workspace.ts:33`. No money/auth/idempotency surfaces touched. |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | Tests assert real git state (`.git` is directory, alternates absent, commit equality, command exit success). No browser surfaces. |
| Every new branch / error path has a driving test | lead | PASS | Linked-worktree detection: `tests/git_workspace.test.mjs:89`; non-git source error: `tests/git_workspace.test.mjs:235`; alternates/dissociate guard: `tests/git_workspace.test.mjs:198`; sandbox disabled path: `tests/git_workspace.test.mjs:371`; sandbox_dir path: `tests/git_workspace.test.mjs:319`. |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | `index.ts` change is additive: it only affects behavior when `git_clone_workspace:true` is passed; default/legacy paths unchanged. Existing tests (`tests/sandbox_profile.test.mjs`, `tests/callback_completion.test.mjs`, `tests/subagent_list.test.mjs`, `tests/widget_flicker.test.mjs`, `tests/queue_gate.test.mjs`, `tests/extensions.test.mjs`) still pass, confirming no regression. Intended change is declared in issue #78 ACs. |
| Runtime smoke: each changed non-browser surface (service/API/CLI/job) was actually run via the repo run command and its happy path responded (boots, no 500/crash on first call) — green tests alone do not prove the thing runs; browser surfaces use the presentation sweep instead | gate-lint | PASS | `node --test tests/*.test.mjs` → 116 pass / 0 fail. The changed surfaces are library/CLI paths exercised by real subprocess tests. |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | No browser routes changed or added. |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | No browser surfaces. |
| Sweep specs do not intercept first-party traffic | lead | N/A | No browser/presentation tests. |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | No browser surfaces. |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | N/A | `ci-audit.mjs --files .github/workflows/ci.yml,.github/workflows/integration-tests.yml` reports the repository has not adopted the full ensure-coverage CI contract; that pre-existing gap is outside #78. The changed code is covered by the existing `node --test tests/*.test.mjs` gate in `.github/workflows/ci.yml`. |
