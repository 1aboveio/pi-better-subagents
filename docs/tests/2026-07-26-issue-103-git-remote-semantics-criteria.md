# Test Criteria — Issue #103: Complete Git remote semantics

Source: https://github.com/1aboveio/pi-better-subagents/issues/103  
Related: blocks #78 / PR #89 (`git-remote-preservation` theme)

## Scope

Reusable library module that reads and syncs complete first-class Git remote
configuration for disposable clone workspaces. Out of scope: full disposable
clone preparation (issue #78), sandboxing, merge queue.

## Surfaces

| Surface id | Kind | Floor |
|---|---|---|
| `git_remotes.read` | library | unit / integration (real `git`) |
| `git_remotes.sync` | library | unit / integration (real `git`) |

## Acceptance Criteria → tests

| AC | Behavior | Required level | Proving test |
|---|---|---|---|
| AC1 | `readGitRemotes` reads from structured null-delimited `git config`, not `git remote -v` text parsing | unit | structured config + whitespace URLs |
| AC2 | Remote representation supports **all** configured `remote.<name>.pushurl` values (array), not a single value | unit | multi-pushurl model |
| AC3 | Syncing remotes into a target preserves multiple push URLs and fetch URLs exactly | integration | sync multi-pushurl |
| AC4 | A source remote with no explicit push URL remains semantically equivalent (no invented pushurl; push uses fetch URL) | integration | fetch-only remote |
| AC5 | Multiple remotes are preserved independently | integration | multi-remote |
| AC6 | Local path remote URLs containing spaces are preserved | unit + integration | whitespace paths |
| AC7 | Stale clone-only remotes are removed when absent from the source | integration | stale removal |
| AC8 | Behavioral: pushes from the prepared target reach **every** configured push destination | integration | multi-pushurl push proof |
| AC9 | Regression: multiple push URLs are not collapsed, dropped, or rewritten to the fetch URL | unit + integration | multi-pushurl regression |

## Mock / fake policy

- Real `git` subprocesses for all Git operations. Git is not mocked.
- No first-party internal seams are mocked.
- Temp bare repositories are real filesystem fixtures.

## Evidence expectations

- RED/GREEN for the multi-pushurl case (the recurring PR #89 blocker).
- Behavioral push proof that both push destinations receive the branch.
- Lint/screens: `lint-tests`, `scope-class`, `coverage-checklist validate`, `scan-diff`.
