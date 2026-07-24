# pi-better-subagents

A better subagent extension for [pi](https://github.com/earendil-works/pi-coding-agent).

Not a clone of Claude Code's subagents — a rethink of what a subagent system
should be: **autonomous, non-blocking, and safe by default.** You delegate work
and keep going; each subagent runs on its own in an isolated process, confined to
what it needs, and reports back when it's done. No blocking waits, no
back-channel for it to stall on, no unbounded blast radius.

```
launch is the result · completion posts back · the foreground never blocks
```

## Principles

- **The foreground never blocks.** Launching a subagent *is* the deliverable —
  `subagent_spawn` starts a detached `pi -p` child and returns immediately,
  leaving the session free for the human. When the child finishes, its result
  posts back into the session (as a `followUp`), never cutting into work in
  progress. The foreground is nudged once, at completion — never on a wait/poll
  loop.
- **Subagents are autonomous; communication is one-way (parent → child).** The
  parent front-loads everything the child needs into the spawn; the child runs to
  completion and **returns a result**. There is no mid-task child→parent blocking
  call for a subagent to waste wall-clock on — a child missing a piece of info
  resolves it from what it was given, or records it unavailable and returns.
- **Safe by default.** Every subagent is OS-sandboxed — writes confined to its
  working directory, reads and network open — and scoped to an explicit tool
  allowlist. It can't corrupt the parent, escape its directory, or recurse into
  more subagents without opt-in.
- **Observable.** A live status widget and on-demand queries show each run's
  elapsed time and token/cost spend.

## Tools

| Tool | Blocks? | What it does |
|------|---------|--------------|
| `subagent_spawn` | never | Launch a task in a background subagent; returns a run id at once. Params: `prompt`, `name`, `model`, `tools` (allowlist), `exclude_tools`, `sandbox`, `sandbox_dir`, `callback`, `clean`, `cwd`, `approve`, `allow_nested`. |
| `subagent_list` | never | List running/finished runs with status, elapsed, and spend. |
| `subagent_output` | never | Tail a run's live output as it stands right now. |
| `subagent_result` | never | Read a finished run's final output (says "still running" otherwise). |
| `subagent_stop` | never | SIGTERM a running run's process group. |

## Non-blocking, by construction

- **Process isolation.** Each run is a `detached` + `unref`'d `pi -p` process.
  Its context can't clog the parent, its crash can't corrupt parent state, and
  its output is durable in a log file.
- **Completion triggers a turn that fetches the result.** When the child exits,
  a lightweight trigger is sent with `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` —
  it waits until the foreground agent has no pending tool calls (never cutting
  into work mid-stream), then the model calls `subagent_result` and presents the
  result. The actual result is never embedded in the trigger to avoid double-display.
  The run itself never blocks the foreground; the single nudge happens only at
  the end. Prefer `callback:false` to finish quietly and read the result on demand
  via `subagent_result`.
- **The prompt guidelines forbid polling.** The foreground agent is told, in the
  tool guidelines, that spawning is done and it must not loop on `output`/`result`
  or sleep to wait.

## Autonomy & safety

Every subagent is confined by default, and the confinement is **self-contained** —
it does not depend on any other extension being installed.

- **OS sandbox (default on, macOS).** The child runs under `sandbox-exec` with a
  simple rule: **reads and network are open; writes are confined to the working
  directory.** Kernel-enforced — unlike a cooperative guardrail that matches tool
  inputs, this denies the write syscall itself, so a crafted `bash` command can't
  escape it. `sandbox:false` lifts it; `sandbox_dir` moves the writable root (and
  becomes the child's cwd). The profile also permits writes to pi's own state
  (`~/.pi`), system temp, and `/dev` so pi can function; everything else (your
  home, the repo, `/etc`, …) is read-only to the subagent.
- **Tool allowlist.** The child is scoped to an explicit set of tools (see below).
- **No runaway recursion.** A subagent cannot spawn its own subagents unless
  `allow_nested:true`.
- **Guardrails compose (bonus).** Because extensions load in the child by default,
  any guardrails extension you run (e.g. `@aliou/pi-guardrails`) also applies
  inside subagents and **fails safe** headlessly — but the sandbox above means you
  don't depend on it for confinement.

## Tool scoping (allowlist)

Precedence, highest first: the per-call `tools` param → `config.json`
`defaultTools` → a built-in default (`read, bash, edit, write, web_search,
web_fetch`; just `read, bash` in a `clean` child). `exclude_tools` subtracts on
top.

`config.json` (next to the extension) also sets:

- `defaultModel` — model for spawns that don't specify one (`null` = inherit the
  foreground model).
- `maxConcurrent` — how many subagents may run at once (**default 4**). A spawn
  past the cap is rejected until a running one finishes.

Extensions load in the child by default, so extension-provided tools
(`web_fetch`, MCP, extension-provided model auth like xai) work out of the box.
Pass `clean:true` for a hermetic, built-ins-only child.

## Status & cost tracking

Driven by the child's `--mode json` usage events:

- **Live widget** above the editor while any subagent runs — a spinner per run
  with elapsed time, the current tool, and running token/cost spend, ticking once
  a second. It clears itself when the last run finishes. (TUI/RPC only; silent in
  `-p`/print mode.)
- **On demand** — `subagent_list`, `subagent_output`, and `subagent_result` all
  carry `elapsed · N tok (↑in ↓out) · $cost · tools`. The completion notice and
  toast include the final elapsed + spend too.

Spend is summed from each finalized assistant turn's `usage` (so multi-turn
tool-using runs total correctly), and cost comes straight from the model's
reported per-request cost.

## Design notes

- Runtime lives outside any repo, under `$TMPDIR/pi-better-subagents/`
  (`runs/<id>/` holds `output.log`, `prompt.md`, `meta.json`; `sessions/` holds
  child session state). The `meta.json` sidecar is authoritative, so `list` /
  `output` / `result` survive turns, `/reload`, and pi restarts.
- The child runs `--mode json`; `subagent_result` / `subagent_output` **parse**
  the event stream and return just the final answer (plus which tools ran).
  Non-JSON banner/warning lines fail to parse and are dropped, so the result is
  clean. The prompt is passed as a **positional argument**, never `@file` — some
  models refuse an @-attached file as untrusted content.
- The child gets **only** the explicit prompt — no silent parent-context bleed.
- `--approve` is **off by default** (headless runs can't prompt for trust).

## Install

Symlink the project into pi's auto-discovered extensions dir:

```bash
ln -sfn "$PWD" ~/.pi/agent/extensions/pi-better-subagents
```

Then `/reload` (or restart pi). It appears as `pi-better-subagents`.

> Do **not** add it to `settings.json`'s `extensions` array — a live pi session
> rewrites that file on its own saves and drops hand-added entries. Auto-discovery
> via the symlink is stable. Quick throwaway test without installing:
> `pi -e ./index.ts`.

## Tests

Real integration smoke tests live in [`tests/`](tests/) — a subagent using
`web_fetch`, one driving `gh`, and env inheritance through the sandbox. See
[`tests/README.md`](tests/README.md).

## Roadmap

Tracked in [issues](https://github.com/exoulster/pi-better-subagents/issues).
Near-term:

- Guarantee subagent autonomy — verify/deny any child→parent supervision
  back-channel so a child can never block on the parent ([#1](https://github.com/exoulster/pi-better-subagents/issues/1)).
- Make `callback:true` a lightweight trigger instead of embedding the full result
  twice ([#2](https://github.com/exoulster/pi-better-subagents/issues/2)) — **done**.
- Named agent-definition files (per-agent system prompt + tool allowlist) and
  chain/parallel orchestration.
