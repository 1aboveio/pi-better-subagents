# Incremental plan — issue #39: prefactor sandbox backend selection behind one platform-neutral seam

Run: epic-5-linux-sandbox, unit #39 (single slice unit; plan kept current as slices land).
Source contract: GitHub issue #5 (full spec/testing decisions) + issue #39 ACs + ADR `docs/adr/0001-linux-sandbox-bubblewrap.md` @ `070c14531ebcf5c9f88e4a333886a55d0c13926b` (verified via `git cat-file -e`).
Explicitly NOT in scope: #40 Linux bwrap discovery/wrapper/mounts/Linux behavior.

Legend: todo / in-progress / done (done = its test runs and asserts the behavior).

## Collision log (must read on resume)

- A concurrent recovery-run producer (self-declared `openai/gpt-5.6-terra`) committed `9a30b2f` ("refactor: isolate sandbox backend selection") on branch `stack/exoulster/issue-39/sandbox-backend-selection-seam` and opened **PR #49** (non-draft) for the same issue #39, at ~18:21–18:29 local. It also deleted this run's untracked working files (plan + 3 new test files) via a clean. This run's contract names kimi-coding/k3 the one producer; this plan + branch `feat/sandbox-backend-selection` (from `070c145`) is this run's delivery. PR #49 is left untouched (stack-managed by the other run). Do NOT build on `9a30b2f`.
- This harness blocks `sandbox_apply`: `/usr/bin/sandbox-exec` exits 71 "Operation not permitted". The deterministic macOS shell probes therefore cannot execute their confinement step locally; profile-generation steps still run. Documented as an environment restriction (also recorded by the other producer), not a code regression; compare pre/post-change probe output.

## Slices

| # | Slice | AC(s) | Type | State | Proving test |
|---|-------|-------|------|-------|--------------|
| A | Characterization tests for unchanged behavior, written + GREEN on pre-change tree: wrapper shape + pi argv order + SBPL profile bytes (`sandbox.command-wrapper`), detached spawn + log capture + argv order (`spawn.detached`) | #39 AC3, AC6, AC7 | characterization | done (GREEN @070c145: 3/3 and 2/2 pass; re-verified after tree restore) | `tests/sandbox_wrapper_contract.test.mjs`, `tests/spawn_detached.test.mjs` |
| B | New seam tests RED on pre-change tree (`selectSandboxBackend` missing) | #39 AC1, AC4 | TDD RED | done (RED @070c145: 6/6 fail, `selectSandboxBackend is not a function`; re-verified after tree restore) | `tests/sandbox_backend_selection.test.mjs` |
| C | Vacuous import-failure defect: prove the pre-change `sandbox_profile.test.mjs` passes vacuously on import failure and the corrected import-strict version fails (scratch copy proof, true old file from `git show 070c145:...`) | #39 AC5 | fails-without-fix | done (old: vacuous PASS in all 3 failure modes; new: hard FAIL in all 3, GREEN healthy) | scratch run evidence; corrected `tests/sandbox_profile.test.mjs` |
| D | Implement prefactor in `sandbox.ts`: `SandboxBackend` interface, sandbox-exec backend, platform registry, exported `selectSandboxBackend(platform?)`, `sandboxSupported()` delegates, `buildSandboxCommand` dispatches with documented behavior-preserving fallback; rewrite `tests/sandbox_profile.test.mjs` import-strict with assertions unchanged | #39 AC1, AC2, AC3, AC5, AC8 | implementation | done (suite 87/87 GREEN, 0 skip) | full unit suite GREEN |
| E | Verify unchanged: caller `index.ts`, `spawn.ts`, `registry.ts` untouched by diff; macOS shell probes attempted (harness blocks `sandbox_apply` — capture pre/post-identical output); runtime smoke of the real builder (unit-level: real profile write + wrapper argv exercised; kernel confinement blocked by harness) | #39 AC2, AC3, AC7, AC8 | verification | done (diff touches only sandbox.ts+tests; probes blocked at sandbox_apply rc=71 by harness, profile steps PASS; module smoke SMOKE OK) | shell probe logs + smoke output |
| F | Surface inventory update (sandbox.* + spawn.detached), gates: lint-tests (diff + mock rule diff/tree), scope-class, coverage-ledger validate (baseline already red: 5 pre-existing widget Unverified), coverage-checklist generate+validate, scan-diff findings empty, evidence-block collect+validate at final HEAD | all | closeout | done (lint-tests 0; scope-class surface-bearing; ledger exit 1 = 5 pre-existing + 5 attestation-pending Unverified, 0 Missing/Orphan; checklist validates; scan-diff findings []) | gate outputs in PR body |

## AC → slice map

- AC1 (backend selection behind one platform-neutral module boundary) → B + D
- AC2 (caller keeps default-on / explicit / opt-out policy shape, no platform conditionals) → E (`index.ts` untouched)
- AC3 (macOS detection/wrapper/SBPL unchanged) → A (pre-change GREEN) + D + E
- AC4 (unsupported-platform support query + explicit-request failure characterized before change) → A (support query pinned) + B (null-backend mapping; characterization, not RED) + E (caller throw path untouched by diff)
- AC5 (import failure must fail, never vacuous pass) → C + D
- AC6 (public support-query + command-wrapper contracts compatible) → A (wrapper contract pinned pre-change) + D
- AC7 (detached spawn, pi arg order, logs, metadata unchanged) → A (spawn/log/argv characterization) + E (index.ts/registry.ts/spawn.ts untouched)
- AC8 (unit + macOS sandbox tests pass, no weakened/skipped assertions) → D + E (existing assertions byte-identical; lint-tests no-skip clean)

## Notes

- `buildSandboxCommand` keeps a documented fallback to the sandbox-exec backend on platforms with no registered backend: that IS the pre-prefactor observable behavior (the function never checked platform) and the existing profile unit test runs on Linux CI — a throw would be a behavior change and would force weakening/rerouting an existing assertion (forbidden by AC8). #40 replaces the fallback when it registers the Linux backend.
- Caller-level explicit-request throw lives in `index.ts`, which is not importable in tests (runtime dep `@earendil-works/pi-ai` not installed in repo). Characterization evidence = the trigger condition pinned by tests (`selectSandboxBackend('linux'/'win32') → null`, `sandboxSupported()` false off-darwin) + `index.ts` provably untouched by the diff.
- Coverage ledger baseline on main is ALREADY red (5 `Unverified` widget.* errors from issue #13, never attested). New sandbox surfaces will land `Unverified` too pending reviewer attestation; execution evidence attached. Recorded honestly, not fabricated green.
