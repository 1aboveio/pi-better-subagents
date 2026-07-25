## Coverage Checklist

_Every row = a decision (PASS / FAIL / N/A) backed by a checkable evidence locator (`file:line`, a rerunnable `command`, or #issue)._

### Breadth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| Surface inventory + route manifest regenerated; no drift | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` cannot inventory this extension: no `coverage.config.json` or repository inventory adapter. |
| Every changed surface is owned and proven at its floor (no Missing/Orphan) | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` exits 0 without output because this repo has no `coverage.config.json` or inventory adapter; no ownership/floor assertion is available. |
| No un-specced capability missed — the surfaces no AC mentions | judgment | PASS | `git-remotes.ts:50` (`readGitRemotes`) and `git-remotes.ts:117` (`syncGitRemotes`) are the only new library surfaces; no CLI/tool/route surface is added. Issue #103 ACs name exactly these two operations. |
| Reachability/mutation classification is correct for changed surfaces | judgment | PASS | Library-only surfaces: `git-remotes.ts` mutates target-repo Git config via real `git remote` subprocesses during `syncGitRemotes`; no HTTP route, tool registration, or DB table is introduced. |

### Depth

| Check | Method | Decision | Evidence |
|---|---|---|---|
| No test skipped/focused/xfail added | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-skip --diff ce8e8a212908f09aa87bdfe6e784552882f9baa1` → 0 findings. |
| No fixed sleep added (waitForTimeout / numeric cy.wait / time.sleep) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-fixed-timeout --diff ce8e8a212908f09aa87bdfe6e784552882f9baa1` → 0 findings. |
| No empty/placeholder test body added (passes vacuously, asserts nothing) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules no-empty-test --diff ce8e8a212908f09aa87bdfe6e784552882f9baa1` → 0 findings. |
| Each added test actually asserts a behavior (not a no-op or helper-only render-health mislabeled as a journey) | lead | PASS | `tests/git_remotes.test.mjs` multi-pushurl read asserts `pushUrls.length === 2`; multi-push sync asserts both bare push destinations receive `multi-proof`; multi-stale→multi-desired regression asserts sync does not throw on multi-valued pushurl and push lands only on desired destinations (not stale); multi-remote asserts stale remote removal; fetch-only asserts push lands on fetch URL only. |
| Declared @level meets each surface floor (no Wrong Level) | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/coverage-ledger.mjs validate` exits 0 without output because this repo has no `coverage.config.json` or inventory adapter; no level floor can be resolved. Tests self-tag `@level unit` with real `git` integration fixtures. |
| First-party interception in a behaviour/journey test is justified, not counted as real coverage | lead | PASS | `tests/git_remotes.test.mjs` uses real `git` subprocesses and temp bare repos; no `page.route`, MSW, or first-party module mock. |
| No mock of a first-party internal seam module (real internals, faked externals) | gate-lint | PASS | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/lint-tests.mjs --rules mock-internal-seam --diff ce8e8a212908f09aa87bdfe6e784552882f9baa1` and whole-tree equivalent → 0 findings. |
| Mock use respects the boundary; money/auth/idempotency never mock-only | judgment | PASS | `tests/git_remotes.test.mjs:14` imports real `../git-remotes.ts`; `tests/git_remotes.test.mjs:36` shells out to real `git` via `execFileSync`; no money/auth surfaces. |
| Assertions are behavior-first; none pass on a 404 / empty / error page | judgment | PASS | Behavioral push proof at `tests/git_remotes.test.mjs:262-275` requires both push destinations to list the new branch; empty branch list on the second destination fails the test. |
| Every new branch / error path has a driving test | lead | PASS | Multi-pushurl read; multi-pushurl sync+push; multi-stale pushurl set → multi-desired rebuild (clears before set-url --push); multi-remote+stale; fetch-only clear leftover pushurl; whitespace URLs. Empty/no-remote path is covered by structured-config empty catch returning `[]` exercised when fixtures start bare. |
| Diffs that modify existing behavior are pinned by a characterization test (prior behavior) before the change — or an intended change is declared with its AC | lead | PASS | New module only (`git-remotes.ts`); no existing production behavior modified. Intended contract is issue #103 ACs (complete multi-pushurl preservation). PR #89 remains free to consume this module later. |
| Runtime smoke: each changed non-browser surface was actually run and its happy path responded | gate-lint | PASS | `docs/tests/_generated/runtime-smoke-results-103.json` → `SMOKE PASS: git_remotes multi-pushurl read+sync+push reached both destinations` for `git_remotes.read` and `git_remotes.sync`. |

### Presentation

| Check | Method | Decision | Evidence |
|---|---|---|---|
| render-health is in the floor for every changed browser route | gate-lint | N/A | `git-remotes.ts` is a Node library module; no browser route changed. |
| Presentation sweep ran (runtime gate): no pageerror/overflow/overlap/shift; nothing blocked | gate-lint | N/A | No browser route changed; see `git-remotes.ts:1`. |
| Sweep specs do not intercept first-party traffic | lead | N/A | No browser sweep/spec is added by this library-only change. |
| Perceivability edge cases the instruments cannot score are checked | judgment | N/A | No browser-rendered surface changed. |

### Enforcement

| Check | Method | Decision | Evidence |
|---|---|---|---|
| CI wires all required gates and keeps them blocking | gate-lint | FAIL | `node /Users/exoulster/.agents/skills/ensure-coverage/scripts/ci-audit.mjs --files .github/workflows/ci.yml` → required inventory, ledger, checklist, evidence, smoke, and presentation gates absent from pre-existing CI configuration. |
