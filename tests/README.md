# Integration tests

Real, end-to-end smoke tests that a tool-scoped subagent can actually do work.
Each test runs the **same child invocation `subagent_spawn` builds** in
`index.ts` (`pi -p --mode json`, tool allowlist, subagent-tool denylist, closed
stdin, positional prompt) and parses the result the way `parse.ts` does.

| Test | Proves |
|------|--------|
| `test_web_fetch.sh` | An extension-provided tool (`web_fetch`) works in a scoped child: fetch `github.com/exoulster/pi-better-subagents`, report a word count. |
| `test_gh_issues.sh` | A `bash`-scoped child can drive an external CLI: `gh issue list -R exoulster/pi-better-subagents`. |
| `test_env_inherit.sh` | The foreground environment (e.g. `GH_TOKEN`) reaches the subagent **through the OS sandbox** — the hardening test for credential passing. |

## Run

```bash
tests/run_all.sh                                   # both, default model
PI_SUBAGENT_TEST_MODEL=xiaomi/mimo-v2.5-pro tests/run_all.sh
PI_SUBAGENT_TEST_TIMEOUT=400 tests/run_all.sh      # slower models
tests/test_web_fetch.sh                            # one test
```

## What to expect

These make **real model calls and hit the network**, and `test_gh_issues.sh`
needs `gh` authenticated (`gh auth status`). They are smoke tests, not CI — a run
can be **cut off** if the model is slow. A cut-off run reports `INCOMPLETE`
(exit 2), which is distinct from a wrong answer (`FAIL`, exit 1) and a pass
(exit 0). On `INCOMPLETE`, just re-run or raise `PI_SUBAGENT_TEST_TIMEOUT`.

Exit codes: `0` pass · `1` finished but assertion failed · `2` incomplete (flake).

## Notes / gotchas baked in

- **stdin must be closed** for the child. `pi -p --mode json` reads stdin as an
  event stream and hangs forever if it stays open; `lib.sh` runs the child with
  `< /dev/null`, mirroring how the extension spawns with stdin `"ignore"`.
- Tests write only under `$TMPDIR/pi-better-subagents-tests/` — never the repo.
- **`gh` needs `GH_TOKEN`.** `gh` authenticates via the macOS keychain by
  default; a spawned child touching the keychain can hang on a prompt it can't
  answer. `test_gh_issues.sh` exports `GH_TOKEN` (from `gh auth token`) to bypass
  it. **Product implication:** real subagents using `gh` want `GH_TOKEN` in the
  foreground pi's env — the child inherits it (see `test_env_inherit.sh`).
- **Empty command output confuses the model.** `gh issue list` prints *nothing*
  when a repo has no issues; the model reads the empty result as an error and
  loops. Ask for output that's always non-empty — here `--json number --jq
  length` prints `0`. General lesson for bash-driving subagents.
- **Don't let a prompt's punctuation leak into a command.** "run: `<cmd>`." can
  make the model append the trailing `.` as a literal argument. Put the command
  on its own line and say "no trailing punctuation."
- **Process hygiene.** The watchdog kills the whole run (`pkill -f "$id"`), not
  just the parent — pi spawns detached children that otherwise pile up and cause
  contention (and flaky timeouts). If runs mysteriously slow down, check for
  stray `pi -p` / `sandbox-exec` processes.
