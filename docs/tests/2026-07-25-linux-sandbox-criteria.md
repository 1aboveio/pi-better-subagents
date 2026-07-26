# Test Criteria: Linux write-sandbox backend (bubblewrap)

## Source

- Input: GitHub issue #5 "Linux write-sandbox support (parity with macOS sandbox-exec)" (OPEN, author exoulster, 2026-07-24) — read in full, including all acceptance criteria, candidate approaches, and out-of-scope list.
- Input: ADR `docs/adr/0001-linux-sandbox-bubblewrap.md` (Status: accepted) — merged into `main` at merge commit `4993a44729bc6f854b58cd1f33a6d1348b733b1e` (PR #35). This criteria doc is branched from exactly that revision.
- Code read on `origin/main` @ `4993a44`: `sandbox.ts`, `index.ts` (`wantSandbox` / `explicitSandbox` degrade-vs-throw flow, spawn assembly at lines ~291–393), `tests/lib.sh` (`require_macos_sandbox`, `_write_sandbox_profile`, `run_sandboxed_bash`, `run_child`, `ext_args`), `tests/test_sandbox_applied.sh`, `tests/test_sandbox_deny_outside.sh`, `tests/test_env_inherit.sh`, `tests/test_web_fetch.sh`, `tests/test_gh_issues.sh`, `tests/sandbox_profile.test.mjs`, `tests/run_queue.sh`, `tests/run_all.sh`, `.github/workflows/ci.yml`, `.github/workflows/integration-tests.yml`.
- Date: 2026-07-25.

## Scope

- In scope: behavior-first acceptance criteria and test obligations for the Linux bubblewrap write-sandbox backend: backend/platform discovery, no-backend policy, post-detection fail-closed policy, bwrap command topology, kernel write confinement (incl. symlink invariant), reads/env/network behavior, caller/API contract, CI wiring, macOS regression, and docs.
- Out of scope (per issue #5 and ADR, restated so no test may silently expand scope): Windows sandbox support; replacing the cooperative guardrails layer; changing the default sandbox-on policy; Landlock/firejail/raw-namespace/Docker backends; any change to macOS SBPL confinement semantics.
- Assumptions (inferred, marked — none block the criteria):
  - `Assumption A1` — "`viable` bwrap" at *discovery* time means: a file named `bwrap` resolvable via `PATH` lookup that is executable. Whether user/mount namespaces actually initialize is verified only at *execution* time (a discovered-but-broken bwrap is the fail-closed case, AC6/AC7), not at discovery. This refines the ADR phrase "viable `bwrap` executable is available"; it is the only reading consistent with the ADR failure matrix, which has a distinct "detected yet failed" state that discovery alone could never reach if discovery probed namespace init.
  - `Assumption A2` — Test helpers must obtain the Linux wrapper from the product's own builder (e.g. importing `sandbox.ts` via `node --experimental-strip-types`, the same pattern `ext_args` in `tests/lib.sh` already uses for `extensions.mjs`), not by mirroring the bwrap argv in shell. The existing `_write_sandbox_profile` mirror is a known drift risk this issue should not replicate for a second backend. This constrains test *topology*, not product behavior.
  - `Assumption A3` — When the integration queue gate moves to `ubuntu-latest`, macOS deterministic sandbox coverage is preserved by adding a macOS lane to the PR gate (`ci.yml`) for the two model-free sandbox-exec tests. Placement is a CI cost/latency decision; the *obligation* (both backends' confinement proven on every merge) is fixed.
  - `Assumption A4` — The explicit-request error message text is implementation-owned; the criteria pin its observable content (platform + missing/failed backend + actionable remedy + `sandbox:false` opt-out), not its exact string. The current string "sandbox is only supported on macOS (sandbox-exec)…" is a **declared intended behavior change** (it becomes wrong the moment a Linux backend exists).
- Blockers: none. No unresolved product decisions; see "Blocking Decisions" (empty).

## Acceptance Criteria

### Discovery and platform policy

- **AC1 — macOS discovery unchanged (characterization).** On macOS with `/usr/bin/sandbox-exec` present, `sandboxSupported()` returns `true` and `buildSandboxCommand` returns the existing `{ file: "/usr/bin/sandbox-exec", fileArgs: ["-f", profile, piBin, ...piArgs] }` wrapper, writing the same SBPL profile shape as today (deny `file-write*` default, allow writable dir, `~/.pi`, `/private/var/folders`, `/private/tmp`, `/dev`). Observable: existing `tests/sandbox_profile.test.mjs`, `tests/test_sandbox_applied.sh`, `tests/test_sandbox_deny_outside.sh` pass unmodified on macOS.
- **AC2 — Linux discovery with bwrap.** On Linux, when an executable `bwrap` is resolvable from `PATH`, `sandboxSupported()` returns `true`. Per A1, discovery performs PATH resolution + executability only — it must not spawn bwrap or probe namespaces.
- **AC3 — Linux discovery without bwrap.** On Linux, `sandboxSupported()` returns `false` when (a) no `bwrap` exists on `PATH`, and (b) a `bwrap` file exists on `PATH` but lacks the executable bit.
- **AC4 — Windows unsupported.** On Windows, `sandboxSupported()` returns `false` and any explicit sandbox request errors clearly. Windows support is out of scope; only the negative contract is tested.
- **AC5 — No-backend policy matrix.** On a platform with no viable backend (Linux without bwrap, Windows): (a) explicit `sandbox:true` throws before any child is spawned; (b) explicit `sandbox_dir` throws identically in kind; (c) the error message names the platform, names the missing backend (`bubblewrap`/`bwrap` on Linux), gives an actionable remedy (install bubblewrap) or the `sandbox:false` opt-out, and does **not** claim sandboxing is "only supported on macOS"; (d) default-on (no explicit request) degrades to direct unsandboxed `pi` execution without error; (e) `sandbox:false` never sandboxes on any platform and performs no wrapper construction.
- **AC6 — Post-detection failure fails closed (policy).** Once a bwrap executable has been selected at discovery, if bwrap exits non-zero or fails to initialize the namespace at spawn time, the spawn fails closed with an error identifying the sandbox backend as the failure cause — for **both** explicit `sandbox:true`/`sandbox_dir` and default-on requests. The implementation must never fall back to running `pi` unsandboxed after a backend was selected.
- **AC7 — Post-detection failure has no unsandboxed side effect (observable proof).** In the AC6 scenario, no direct-exec retry occurs: an unsandboxed child run would produce an observable side effect (e.g. a marker file the child command writes, a session artifact, or a recorded exec of bare `pi`), and the test must assert that side effect is **absent**. Asserting only "an error was thrown" is insufficient — the test must prove the fallback path did not execute.

### Linux wrapper topology and confinement

- **AC8 — Caller shape preserved.** The sandbox builder invoked from `index.ts` returns `{ file, fileArgs }` wrapping the pi argv (`file` = bwrap, `fileArgs` = bwrap flags followed by `piBin` + the unmodified pi args, order preserved), so the spawn call site needs no platform branch beyond the existing `wantSandbox`/`explicitSandbox` policy flow. The detached-child + log-file spawn shape is unchanged.
- **AC9 — Command construction (narrow unit).** The constructed Linux command, inspected as a pure unit on its argv/mount spec: (a) host root `/` is mounted read-only; (b) the selected writable workdir is canonicalized (symlink-resolved) *before* binding and is rebound writable at its canonical path; (c) host `/tmp` is bound writable; (d) `/dev` is usable (dev/bind mount present); (e) no network isolation flag (`--unshare-net` or equivalent) is present; (f) `~/.pi` gets no writable binding (it stays read-only through the read-only root). This is the **only** argv-string-level assertion permitted; every mount claim here must also be proven behaviorally by AC10–AC13.
- **AC10 — Write confinement with real bwrap.** Under the real bwrap wrapper produced by the product builder: (a) writing a file inside the workdir succeeds and content round-trips; (b) writing to an absolute path outside every writable root fails with non-zero exit **and the file does not exist afterward**; (c) after the denial, a positive-control write inside the workdir still succeeds (the sandbox is not accidentally deny-all). The outside probe must not sit under `/tmp`, `/dev`, or the workdir.
- **AC11 — Symlink invariant (ADR writable-path invariant).** (a) A symlink *inside* the writable workdir pointing at a target *outside* it cannot be written through: the write fails and the outside target's content is byte-identical afterward. (b) When the workdir itself is supplied through a symlinked alias path, the alias is canonicalized before binding, so writes through the alias land in the real directory and the confinement boundary is the real path, not the alias spelling.
- **AC12 — Reads and system paths with real bwrap.** Inside the sandbox: (a) reading a pre-existing file outside the workdir (e.g. under `$HOME`) succeeds; (b) a write probe into `~/.pi` fails and creates/modifies no file there; (c) writing under `/tmp` succeeds; (d) writing to `/dev/null` succeeds.
- **AC13 — Network is shared.** Inside the sandbox, deterministic outbound HTTPS egress (e.g. fetching a fixed URL with `curl`) succeeds, proving the network namespace is shared (no `--unshare-net`). This is the deterministic complement to the real-model AC15 smoke; it is not a substitute for it.

### Environment, model, and tool behavior through the sandbox (queue lane, real)

- **AC14 — Environment inheritance through bwrap.** `tests/test_env_inherit.sh` passes on Linux: a marker env var exported in the foreground shell is visible to a sandboxed (`read,bash`-scoped) child via `printenv`, and the child reports the exact value back. Env must survive the wrapper (bwrap must not scrub the environment).
- **AC15 — Real model call + web_fetch through bwrap.** A tool-scoped sandboxed child completes a real model call and a real `web_fetch` on Linux (network shared, reads open), finishing with a terminal event and an answer containing the fetched content.
- **AC16 — `gh` through bwrap.** A `bash`-scoped sandboxed child drives `gh` against this repository on Linux (via `GH_TOKEN` env, keychain-free) and reports a concrete result.

### API / caller regression

- **AC17 — No caller platform branch; backend-specific errors.** `index.ts` gains no platform conditional for sandboxing beyond the existing `wantSandbox` / `explicitSandbox` degrade-vs-throw flow; the same policy code path serves macOS and Linux. Error messages thrown from that flow are platform/backend-specific per AC5(c). `sandboxSupported` / `buildSandboxCommand` (or its sibling) keep their caller-visible contract (`boolean`; `{file, fileArgs}`), so `index.ts`'s sandbox block is unchanged in shape.

### CI wiring

- **AC18 — Queue gate on ubuntu with bubblewrap, env-inherit included.** The integration workflow runs the queue suite on `ubuntu-latest`, installs `bubblewrap` (and verifies the install, failing the job if `bwrap` is absent), and `tests/run_queue.sh` includes the env-inheritance test (AC14) in addition to the confinement, web_fetch, gh, and headless-isolation tests — satisfying issue #5's requirement that env inheritance is part of the queue gate. On Linux, sandbox tests **execute**; they do not skip.
- **AC19 — Deterministic confinement in the PR gate; macOS regression lane.** The PR gate (`ci.yml`, `ubuntu-latest`) installs bubblewrap and runs: the unit suite (AC2–AC9, AC17) and the deterministic real-bwrap tests (AC10–AC13). A macOS lane runs the existing deterministic sandbox-exec tests (AC1) so macOS confinement proof survives the queue's move to Ubuntu (A3). Real-model/network smokes (AC14–AC16) stay in the queue lane only.
- **AC20 — No skip/guard may make Linux green.** On `ubuntu-latest` CI the sandbox tests must run and assert: `require_macos_sandbox` (or its replacement) may route by platform (sandbox-exec on macOS, bwrap on Linux) but must not exit-0-skip on Linux; a missing bwrap on a Linux CI runner is a hard failure, not a skip. Any platform-routing helper reports which backend it selected.

### Regression and docs

- **AC21 — macOS regression.** On macOS, `tests/test_sandbox_applied.sh`, `tests/test_sandbox_deny_outside.sh`, and `tests/sandbox_profile.test.mjs` pass with their assertions **unweakened**; any change to `tests/lib.sh` (`_write_sandbox_profile`, `run_sandboxed_bash`, `run_child`) is additive backend routing, and the generated SBPL profile content for macOS is unchanged (pinned by the profile-content assertions already in those tests). The bwrap implementation must not alter the SBPL profile or the macOS wrapper argv.
- **AC22 — Docs.** `README.md` (or linked docs) documents: the Linux backend is bubblewrap, the package dependency and install command (e.g. `apt install bubblewrap`), and the behavioral difference that `~/.pi` is read-only on Linux (children must direct pi state/temp to the workdir or `/tmp`). Verifiable by a scripted grep check plus human review.

## Critical User/System Journeys

- **J1 — Sandboxed subagent on a Linux dev host.** User on Linux with bubblewrap installed spawns a default-on subagent → discovery finds bwrap → child runs confined → child can read, call the model, web_fetch, and use `gh`, but a crafted `bash` write outside the workdir is denied at the syscall level. Covered by AC2, AC8–AC16.
- **J2 — Explicit request on a host without a backend.** Caller passes `sandbox:true` (or `sandbox_dir`) on Linux without bwrap → clear, actionable error before spawn; nothing runs. Covered by AC3, AC5.
- **J3 — Broken bwrap on a CI runner.** bwrap is on `PATH` but namespace init fails (restricted kernel) → default-on subagent fails closed with a backend-identifying error and no unsandboxed child ever executes. Covered by AC6, AC7.
- **J4 — Merge-queue gate.** A PR enters the Mergify queue → queue branch runs the full integration suite on `ubuntu-latest` with bubblewrap → confinement, env-inherit, web_fetch, gh, and headless-isolation tests all execute and pass; macOS confinement remains proven in the PR gate. Covered by AC18–AC21.

## Test Matrix

| # | Scenario | AC/Journey | Test level | Mock/Fake policy | Setup/Input | Assertions | Required evidence |
|---|---|---|---|---|---|---|---|
| 1 | macOS discovery + profile (characterization) | AC1 | Pure unit + deterministic integration (sandbox-exec) | Real everything | Existing tests on macOS | Existing assertions unchanged | macOS lane log, GREEN pre- and post-change |
| 2 | Linux discovery, bwrap present | AC2 | Pure unit | Real code; temp `PATH` dir with a real executable stub file named `bwrap` (exec bit set) | PATH containing stub dir | `sandboxSupported()` === true; discovery did not spawn bwrap (stub records invocations → zero) | ubuntu unit-test log |
| 3 | Linux discovery, bwrap absent / non-executable | AC3 | Pure unit | Same temp-PATH technique | PATH without bwrap; PATH with non-exec `bwrap` file | `sandboxSupported()` === false in both | ubuntu unit-test log |
| 4 | Windows negative contract | AC4 | Pure unit | Injectable platform seam (pure decision logic) **or** a `windows-latest` unit job | platform=win32 | `sandboxSupported()` === false; explicit request throws | unit-test log |
| 5 | No-backend policy matrix | AC5 | Pure unit / integration through the real caller path | Real `index.ts` policy flow; stub PATH without bwrap; no model | Each of: `sandbox:true`, `sandbox_dir`, default-on, `sandbox:false` | throw/no-throw per matrix; message matches `bubblewrap\|bwrap` and `sandbox:false` (or an install remedy), and not `only supported on macOS`; default-on spawns unsandboxed | unit-test log |
| 6 | Post-detection fail-closed | AC6, AC7 / J3 | Integration (no real namespaces needed) | Stub executable `bwrap` on temp PATH that exits non-zero (fakes the external binary at its boundary); real extension spawn/policy code; spy or exec-marker at the `child_process` boundary (was-not-called assertion, allowed) | Discovered-but-failing bwrap; explicit and default-on cases | Error identifies sandbox backend; **marker/side effect of an unsandboxed pi run is absent** (AC7) | unit/integration log showing both cases |
| 7 | Caller shape | AC8, AC17 | Pure unit + diff review | Real builder | Invoke builder with known piBin/piArgs | Returns `{file, fileArgs}`; pi argv appended intact and in order; no platform branch added in `index.ts` | unit log + PR diff |
| 8 | Command construction | AC9 | Pure unit (narrow, argv-level) | Real builder; no bwrap execution | Known workdir incl. a symlinked alias spelling | Mount spec per AC9(a)–(f); workdir canonicalized | ubuntu unit log |
| 9 | Write confinement, real bwrap | AC10 / J1 | Deterministic integration, **real bwrap** | Real bwrap, real fs; no model | Workdir + outside dir (outside `/tmp`,`/dev`,workdir) | Inside write round-trips; outside write non-zero AND file absent; positive control passes after denial | ubuntu CI log |
| 10 | Symlink invariant, real bwrap | AC11 | Deterministic integration, real bwrap | Real bwrap, real fs | Symlink inside workdir → outside target; alias-spelled workdir | Write-through fails; outside target byte-identical; alias canonicalized | ubuntu CI log |
| 11 | Reads/system paths, real bwrap | AC12 | Deterministic integration, real bwrap | Real bwrap, real fs | Pre-seeded `$HOME` file; `~/.pi` probe; `/tmp`; `/dev/null` | Per AC12(a)–(d) | ubuntu CI log |
| 12 | Network shared | AC13 | Deterministic integration, real bwrap | Real bwrap; **real outbound HTTPS** to a fixed URL (external boundary left real — it is the subject under test) | curl a fixed URL inside sandbox | Non-empty 2xx response | ubuntu CI log |
| 13 | Env inheritance | AC14 / J1 | Queue real-model integration | Real pi, real model, real bwrap | `tests/test_env_inherit.sh` on ubuntu | Marker value echoed by sandboxed child | queue-gate run log on `mergify/merge-queue/*` |
| 14 | Model + web_fetch | AC15 / J1 | Queue real-model integration | Real model + real web_fetch (explicitly permitted; must stay real) | Sandboxed scoped child | Terminal event + answer reflects fetched content | queue-gate run log |
| 15 | gh through sandbox | AC16 / J1 | Queue real-model integration | Real `gh` + `GH_TOKEN` (real external, permitted in queue lane) | bash-scoped sandboxed child | Concrete `gh` result reported | queue-gate run log |
| 16 | CI wiring | AC18, AC19, AC20 | CI config audit + observed runs | n/a | PR + queue runs | ubuntu + bubblewrap in both workflows; run_queue includes env-inherit; no skip path on Linux; macOS lane present | workflow diffs + run URLs |
| 17 | macOS regression | AC21 | Existing tests, unmodified assertions | Real sandbox-exec | macOS lane | Existing tests pass; SBPL profile content unchanged | macOS lane log |
| 18 | Docs | AC22 | Scripted grep + human review | n/a | README | Mentions bubblewrap, install cmd, `~/.pi` read-only difference | ci grep step + review |

## Mock And Integration Policy

- **Real first-party internals, always:** `sandbox.ts` (discovery, builder), `index.ts` policy flow, `extensions.mjs` resolver, the real `bwrap` binary for all confinement/read/network proofs, real `pi` for child runs. No test may substitute the extension's own sandbox code with a shell re-implementation (A2); a mirrored bwrap argv in `lib.sh` is the same drift defect `_write_sandbox_profile` already represents and is rejected.
- **Faked externals (permitted, at the trust boundary only):** a stub executable named `bwrap` on a temp `PATH` — for discovery tests (rows 2–3) and the discovered-but-failing fail-closed tests (row 6). bwrap-the-binary is an external dependency; the stub fakes *it*, never the extension code around it. A spy/exec-marker at the `child_process` spawn boundary is allowed solely for the AC7 was-not-called proof.
- **Must stay real (explicitly permitted live externals, queue lane only):** the model API, `web_fetch`, and `gh` in AC14–AC16 — these are issue-#5-mandated smokes and may not be faked. AC13's curl egress is also real by design (network sharing is the behavior under test).
- **Integration required (never mock-only):** write confinement (AC10), symlink invariant (AC11), read/system-path behavior (AC12), fail-closed no-retry (AC7) — these are security-boundary behaviors; per policy, security-critical ACs are never mock-only even with approval.
- **Mock-only exceptions:** none requested. The narrow argv-level unit (AC9) is a pure-decision-logic test, not a mock; it is insufficient alone and is paired with AC10–AC13 by construction.

## Required Automated Tests

- **Unit (`node --test`, cross-platform, PR gate):**
  - `tests/sandbox_bwrap.test.mjs` (new): discovery matrix (AC2–AC4, temp-PATH technique, injectable platform seam if used), no-backend policy matrix through the real caller path (AC5), fail-closed both-request-types + absent-side-effect proof (AC6, AC7), caller shape (AC8), argv construction incl. canonicalization and no `--unshare-net` (AC9), message content (AC5c/AC17).
  - `tests/sandbox_profile.test.mjs` (existing): unchanged for macOS (AC1); its `sandboxSupported`-on-non-darwin assertion must be re-routed, not weakened — on ubuntu-with-bwrap the expected value becomes `true` (AC2), asserted by platform, never by "whatever the host is."
- **Deterministic integration (real bwrap, PR gate on ubuntu-latest):**
  - Extend `tests/test_sandbox_applied.sh` and `tests/test_sandbox_deny_outside.sh` with backend routing so AC10 runs under bwrap on Linux and sandbox-exec on macOS with identical assertions (AC10, AC21).
  - New `tests/test_sandbox_symlink.sh` (AC11).
  - New `tests/test_sandbox_paths.sh` (AC12 reads / `~/.pi` ro / `/tmp` / `/dev`, plus AC13 curl egress — or a separate `tests/test_sandbox_network.sh`).
  - `tests/lib.sh`: replace `require_macos_sandbox` with backend-routing (`require_write_sandbox`) that selects bwrap on Linux / sandbox-exec on macOS, hard-fails on Linux CI without bwrap, and reports the selected backend (AC20). Add a builder helper that derives the bwrap wrapper from `sandbox.ts` itself (A2).
- **Queue real-model integration (queue lane, ubuntu-latest):** `tests/run_queue.sh` adds `tests/test_env_inherit.sh` (AC14) and runs the sandboxed web_fetch (AC15) and gh (AC16) smokes under the Linux sandbox; `test_headless_isolation.sh` unchanged.
- **Contract/API:** covered by unit rows 5–8 (the "API" here is `sandboxSupported`/`buildSandboxCommand` + `subagent_spawn` params, not HTTP).
- **UI/E2E:** not applicable — no browser surface.

## RED/GREEN and Characterization Expectations

- **RED now (on `origin/main` @ `4993a44`):** every AC2–AC16 test fails today — `sandboxSupported()` is false on Linux, there is no bwrap wrapper, the error message says "only supported on macOS," and the sandbox shell tests exit-0 SKIP on Linux. This is a TDD red→green feature; implementers must capture the RED state (ubuntu run) before implementation and the GREEN state after, per AC. Tests whose vacuous-pass risk is real (especially AC7's absent-side-effect and AC10's file-absence assertions) carry `// @fails-without-fix linux-sandbox` and must demonstrably exercise the real code path, not a proxy.
- **GREEN before and after (characterization):** AC1/AC21 are pinned by existing tests (`sandbox_profile.test.mjs`, `test_sandbox_applied.sh`, `test_sandbox_deny_outside.sh`) — characterization obligation **waived as already-pinned** (cited: `tests/sandbox_profile.test.mjs` profile-content assertions; `test_sandbox_applied.sh` step 1). The explicit-request error-message change is a **declared intended behavior change** (A4): the diff must show the old assertion replaced by the new backend-specific one.
- **No skip-to-green:** the current `require_macos_sandbox` exit-0 SKIP on Linux is exactly the guard this issue exists to remove in CI; AC20 forbids re-introducing it in routed form. Platform *routing* (run the same assertions under the platform's backend) is the allowed mechanism — selection ≠ skip.

## Coverage Mapping (closed world: every issue #5 AC and every ADR statement)

### Issue #5 acceptance criteria

| Issue #5 AC | Criteria ACs | Test case/file | Status |
|---|---|---|---|
| `sandboxSupported()` true on Linux when viable backend available | AC2 (def. of viable: A1), AC3 | `tests/sandbox_bwrap.test.mjs` | Required |
| `buildSandboxCommand` (or sibling) wraps pi so outside writes fail at OS level | AC8, AC9, AC10, AC11 | `sandbox_bwrap.test.mjs`; `test_sandbox_applied.sh`; `test_sandbox_deny_outside.sh`; `test_sandbox_symlink.sh` | Required |
| Network and reads still work (model call + `web_fetch` smoke) | AC12(a), AC13, AC15 | `test_sandbox_paths.sh`; `test_web_fetch.sh` (sandboxed, queue) | Required |
| `tests/test_env_inherit.sh` passes on Linux | AC14, AC18 | `test_env_inherit.sh` in `run_queue.sh` | Required |
| Explicit request on unsupported Linux errors clearly; default-on degrades safely | AC5, AC3 | `sandbox_bwrap.test.mjs` policy matrix | Required |
| Docs/README note Linux backend + package dependency | AC22 | README + grep check | Required |
| CI runs sandbox integration test on `ubuntu-latest` without macOS | AC18, AC19, AC20 | workflow diffs + run logs | Required |
| (Desired-behavior table: syscall-level, not tool-input filtering) | AC10, AC11 (denial at write syscall via real bwrap, crafted-bash probes) | as above | Required |
| (Desired: callers need no platform branch) | AC17, AC8 | unit + diff review | Required |
| Out of scope: Windows / guardrails / default policy | AC4 (negative only); no criteria expand scope | `sandbox_bwrap.test.mjs` | Excluded (scope) |

### ADR 0001 statements

| ADR statement | Criteria ACs | Status |
|---|---|---|
| Decision: backend is bwrap, discovered from PATH | AC2, AC3, AC9 | Required |
| Decision: `sandboxSupported()` true on Linux only with viable bwrap | AC2, AC3 (viable = exec resolution, A1) | Required |
| Decision: no backend → explicit errors clearly; default-on degrades | AC5 | Required |
| Decision: backend present but init/spawn fails → fail closed, even default-on; never retry unsandboxed | AC6, AC7 | Required |
| Decision: root fs and `~/.pi` readable but read-only | AC9(a),(f), AC12(a),(b) | Required |
| Decision: writable = workdir + host `/tmp`; `/dev` usable | AC9(b)–(d), AC10(a), AC12(c),(d) | Required |
| Decision: network shared, no `--unshare-net` (model API + web_fetch keep working) | AC9(e), AC13, AC15 | Required |
| Decision: macOS `sandbox-exec` unchanged | AC1, AC21 | Required |
| Decision: Windows out of scope | AC4 | Required |
| Failure matrix row: no bwrap, explicit → error | AC5(a),(b) | Required |
| Failure matrix row: no bwrap, default-on → degrade | AC5(d) | Required |
| Failure matrix row: bwrap detected, init fails, explicit → error | AC6 (explicit case) | Required |
| Failure matrix row: bwrap detected, init fails, default-on → error, never retry | AC6, AC7 (default-on case) | Required |
| Writable-path invariant: workdir canonicalized before binding | AC9(b), AC11(b) | Required |
| Writable-path invariant: symlink inside workdir cannot write through | AC11(a) | Required |
| Consequence: `~/.pi` read-only differs from macOS; children use workdir/`/tmp` | AC12(b), AC22 | Required |
| Verification: CI installs bubblewrap, integration runner → `ubuntu-latest` | AC18, AC19 | Required |
| Verification: deterministic confinement both ways | AC10 | Required |
| Verification: `test_env_inherit.sh` passes on Linux | AC14, AC18 | Required |
| Verification: real-model smoke (model call + web_fetch) | AC15 | Required |
| Verification: `gh` smoke (bash-scoped child) | AC16 | Required |
| Verification: existing macOS tests keep passing unchanged | AC1, AC21 | Required |
| Considered options (Landlock / namespaces / chain / Docker rejected) | — | Excluded (decision rationale, no behavior) |

Orphan check: every criterion maps to at least one issue AC or ADR statement (AC13 maps to "network shared" + verification obligations; AC17 maps to the issue's "callers should not need a platform branch"; AC20 maps to the issue's "the sandbox test is skipped on Linux and we lose coverage" motivation + ADR verification obligations). No issue AC or ADR invariant is unmapped.

## Test Skipping

- Skipped tests introduced by this work: **None allowed.**
- Inherited skip being removed: `require_macos_sandbox` exit-0 SKIP on non-macOS in `test_sandbox_applied.sh` / `test_sandbox_deny_outside.sh` — replaced by platform routing that *runs* the tests under bwrap on Linux (AC20). On Linux CI, missing bwrap is a hard failure, not a skip.
- Platform scoping that remains legitimate: macOS sandbox-exec tests run only in the macOS lane and Linux bwrap tests only in Linux lanes (matrix routing, "selection ≠ skip"); each lane's tests run and assert. No test body may no-op behind an environment guard while reporting pass.

## Behavior-First Validation

- ACs describe externally observable behavior (support boolean, thrown errors and their content, files created/absent on disk, byte-identical targets, child-visible env, fetched content, gh output, CI lanes), not private functions — except AC9, an explicitly narrow argv-unit paired with behavioral proofs.
- Test matrix validates outcomes, durable state (files), side effects (absent unsandboxed exec), failure behavior (fail-closed), and security boundaries (confinement, symlink).
- Unit tests are scoped to public behavior and pure decision logic (discovery, policy matrix, argv construction).
- Mock-only coverage never stands in for confinement/fail-closed behavior; substitutes appear only at the bwrap-binary and exec boundaries; queue smokes stay real.
- Existing coverage claims were verified by reading the actual test code (`sandbox_profile.test.mjs`, both shell sandbox tests, `lib.sh`, queue/workflow files), not prior summaries.
- Route discovery / presentation axis: not applicable (no browser surface).
- Verdict analog for criteria completeness: all 7 issue ACs and all 22 ADR statements mapped; no `Unrealized requirement`, no `Orphan surface`.
- Status: **PASS**
- Required revisions before approval: None.

## Reviewer Checklist (for the implementation PR)

- Every AC maps to an automated test above; AC22 additionally needs human doc review.
- Confinement/fail-closed tests (AC6, AC7, AC10, AC11) assert real filesystem / real bwrap outcomes — reject any version that mocks the extension's own sandbox code or mirrors bwrap argv in shell.
- AC7's absent-side-effect proof is present and would go red if an unsandboxed fallback existed (`@fails-without-fix`).
- No new skip/guard on Linux; `run_queue.sh` runs env-inherit; ubuntu lane fails hard without bwrap.
- macOS assertions byte-for-byte unweakened; error-message change shows old→new assertion delta in the diff.
- Evidence attached: ubuntu PR-gate log (unit + deterministic bwrap), queue-gate run URL on a `mergify/merge-queue/*` branch (env-inherit, web_fetch, gh), macOS lane log, README diff.

## Blocking Decisions (need a human answer to finalize the criteria)

None. All obligations were resolvable from issue #5, ADR 0001, and the current code; the four inferences are marked `Assumption A1–A4` in Scope with their defaults stated.
