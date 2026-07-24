# pi-better-subagents

Claude Code-style async subagents for [pi](https://github.com/earendil-works/pi-coding-agent).

The one invariant: **foreground availability**. Launching a subagent *is* the
deliverable — `subagent_spawn` starts a detached `pi -p` child and returns
immediately, leaving the foreground session free for the human *while it runs*.
When the child finishes, its **result is posted back** into the session (as a
`followUp`, so it never cuts into work in progress). The foreground is never
blocked on a wait/poll loop — it's only nudged once, at completion, with the
answer.

```
launch is the result · completion posts back · the foreground never blocks
```

## Tools

| Tool | Blocks? | What it does |
|------|---------|--------------|
| `subagent_spawn` | never | Launch a task in a background subagent; returns a run id at once. Params: `prompt`, `name`, `model`, `tools` (allowlist), `exclude_tools`, `clean`, `sandbox`, `sandbox_dir`, `cwd`, `approve`, `allow_nested`. |
| `subagent_list` | never | List running/finished runs with status. |
| `subagent_output` | never | Tail a run's live output as it stands right now. |
| `subagent_result` | never | Read a finished run's final output (says "still running" otherwise). |
| `subagent_stop` | never | SIGTERM a running run's process group. |

## How it stays non-blocking

- **Process isolation.** Each run is a `detached` + `unref`'d `pi -p` process.
  Its context can't clog the parent, its crash can't corrupt parent state, and
  its output is durable in a log file.
- **Result posts back on completion.** When the child exits, the parsed result
  is sent with `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`
  — it waits until the foreground agent has no pending tool calls (never cutting
  into work mid-stream), then surfaces the answer. The run itself never blocks
  the foreground; the single nudge happens only at the end.
- **The prompt guidelines forbid polling.** The foreground agent is told, in the
  tool guidelines, that spawning is done and it must not loop on
  `output`/`result` or sleep to wait.
- **Clean child by default.** The child loads no global extensions
  (`--no-extensions`) — only built-in tools (`read/bash/edit/write`) unless
  `load_extensions:true`. Restrict further with the `tools` allowlist.

## Status tracking

Claude Code-style, driven by the child's JSON usage events:

- **Live widget** above the editor while any subagent runs — a spinner per run
  with elapsed time, the current tool, and running token/cost spend, ticking
  once a second. It clears itself when the last run finishes. (TUI/RPC only;
  silent in `-p`/print mode.)
- **On demand** — `subagent_list`, `subagent_output`, and `subagent_result` all
  carry `elapsed · N tok (↑in ↓out) · $cost · tools`. The completion notice and
  toast include the final elapsed + spend too.

Spend is summed from each finalized assistant turn's `usage` (so multi-turn
tool-using runs total correctly), and cost comes straight from the model's
reported per-request cost.

## Guardrails & sandboxing

Two layers confine what a subagent can do:

1. **Guardrails (cooperative).** Because extensions load in the child, the user's
   `@aliou/pi-guardrails` runs *inside* every subagent — `pathAccess` allowlist +
   `permissionGate`. Headless, these **fail safe**: anything that would need a
   confirmation (a dangerous command, a write outside the allowlist) is *blocked*,
   never auto-allowed.
2. **OS sandbox (kernel-enforced, opt-in, macOS).** `sandbox:true` or
   `sandbox_dir:"/path"` wraps the child in `sandbox-exec` so its file **writes**
   are confined to one directory (reads and network stay open, so web_fetch and
   the model API keep working). Unlike guardrails — which match tool inputs and
   can in principle be evaded by a crafted `bash` command — this denies the write
   syscall itself. `sandbox_dir` also becomes the child's working directory.

The sandbox profile also permits writes to pi's own state (`~/.pi`), the system
temp dirs, and `/dev` so pi can function; everything else (your home, the repo,
`/etc`, …) is read-only to the subagent.

## Tool scoping (allowlist)

Precedence, highest first: the per-call `tools` param → `config.json`
`defaultTools` → a built-in default (`read, bash, edit, write, web_search,
web_fetch`; just `read, bash` in a `clean` child). `exclude_tools` subtracts on
top. `config.json` (next to the extension) also sets `defaultModel` and
`maxConcurrent` — how many subagents may run at once (default 4). A spawn past
the cap is rejected until a running one finishes.

## Design choices (MVP)

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
- Children **cannot recursively spawn** subagents unless `allow_nested: true`.
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

## Not in the MVP

Named agent-definition files (per-agent system prompt + tool allowlist) and
chain/parallel orchestration are deliberate fast-follows, not part of the first
cut.
