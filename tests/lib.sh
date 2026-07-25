#!/usr/bin/env bash
# Shared helpers for pi-better-subagents integration tests.
#
# These run the SAME child invocation `subagent_spawn` builds in index.ts
# (pi -p --mode json, tool allowlist, subagent-tool denylist, positional
# prompt), then parse the result the SAME way parse.ts does. They exercise the
# real subagent execution path — a tool-scoped child doing real work — without
# depending on a foreground LLM to place the tool call. The extension's
# spawn/registry/parse/callback/sandbox plumbing is verified separately.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="${TMPDIR:-/tmp}/pi-better-subagents-tests"
SESS="$RUNTIME/sessions"

# Overridable knobs.
CHILD_MODEL="${PI_SUBAGENT_TEST_MODEL:-minimax-cn/MiniMax-M3}"
TEST_TIMEOUT="${PI_SUBAGENT_TEST_TIMEOUT:-300}"

SUBAGENT_DENY="subagent_spawn,subagent_list,subagent_output,subagent_result,subagent_stop"

mkdir -p "$SESS"

# require_macos_sandbox
#   Exit 0 with SKIP on non-macOS / missing sandbox-exec. Security tests that
#   need kernel confinement call this first (macOS-only for now; see issue #5).
require_macos_sandbox() {
    if [ "$(uname -s)" != "Darwin" ] || [ ! -x /usr/bin/sandbox-exec ]; then
        echo "  SKIP: OS write-sandbox tests require macOS sandbox-exec (see issue #5 for Linux)."
        exit 0
    fi
}

# _write_sandbox_profile FILE WRITABLE_DIR
#   Mirrors sandbox.ts: reads/network open, writes confined to WRITABLE_DIR plus
#   the system paths pi needs. Keep in sync with sandbox.ts.
_write_sandbox_profile() {
    local file="$1" raw="$2" dir
    mkdir -p "$raw" "$(dirname "$file")"
    # Match sandbox.ts realpathSync: sandbox-exec evaluates canonical paths
    # (/tmp → /private/tmp on macOS).
    dir="$(cd "$raw" 2>/dev/null && pwd -P || echo "$raw")"
    cat > "$file" <<EOF
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "$dir"))
(allow file-write* (subpath "$HOME/.pi"))
(allow file-write* (subpath "/private/var/folders"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/dev"))
EOF
}

# run_sandboxed_bash SANDBOX_DIR BASH_SCRIPT
#   Runs `bash -c SCRIPT` under the SAME sandbox-exec profile subagent children
#   use (via run_child SANDBOX_DIR / extension sandbox.ts). cwd is SANDBOX_DIR.
#   No model involved — deterministic confinement checks. Prints script stdout.
#   Returns the sandboxed bash exit code.
run_sandboxed_bash() {
    local sbxdir="$1" script="$2"
    local prof rc
    mkdir -p "$RUNTIME/runs" "$sbxdir"
    prof="$RUNTIME/runs/sbx_bash_$$_$RANDOM.sb"
    _write_sandbox_profile "$prof" "$sbxdir"
    # Use the resolved writable root as cwd (same as run_child).
    local runcwd; runcwd="$(cd "$sbxdir" && pwd -P)"
    ( cd "$runcwd" && /usr/bin/sandbox-exec -f "$prof" /bin/bash -c "$script" )
}

# run_child ID TOOLS PROMPT [SANDBOX_DIR]
#   Runs the child as the extension does and writes the JSON stream to
#   $RUNTIME/runs/ID.log. With SANDBOX_DIR set, wraps in sandbox-exec confining
#   writes to that dir (and runs there). Returns exit code (124 on timeout).
run_child() {
    local id="$1" tools="$2" prompt="$3" sbxdir="${4:-}"
    local log="$RUNTIME/runs/$id.log"
    mkdir -p "$RUNTIME/runs"

    local -a pre=()
    local runcwd="$SESS"
    if [ -n "$sbxdir" ]; then
        mkdir -p "$sbxdir"
        _write_sandbox_profile "$RUNTIME/runs/$id.sb" "$sbxdir"
        pre=(/usr/bin/sandbox-exec -f "$RUNTIME/runs/$id.sb")
        runcwd="$sbxdir"
    fi

    # A portable timeout wrapper (macOS has no `timeout`): background + watchdog.
    # stdin MUST be closed (< /dev/null): `--mode json` otherwise waits on stdin
    # forever. The extension spawns children with stdin "ignore" for this reason.
    # ${pre[@]+...} guards the empty-array case under `set -u` on bash 3.2 (macOS).
    ( cd "$runcwd" && ${pre[@]+"${pre[@]}"} pi -p --mode json \
        --session-dir "$SESS" --session-id "$id" \
        --model "$CHILD_MODEL" \
        --tools "$tools" \
        --exclude-tools "$SUBAGENT_DENY" \
        "$prompt" < /dev/null ) > "$log" 2>&1 &
    local pid=$!
    local waited=0
    while kill -0 "$pid" 2>/dev/null; do
        if [ "$waited" -ge "$TEST_TIMEOUT" ]; then
            # Kill the whole run, not just the subshell: pi spawns detached
            # children (and a sandbox-exec wrapper) that would otherwise orphan
            # and pile up. The run id is unique, so pkill on it is safe.
            kill -TERM "$pid" 2>/dev/null
            pkill -f "$id" 2>/dev/null
            sleep 1
            kill -KILL "$pid" 2>/dev/null; pkill -9 -f "$id" 2>/dev/null
            return 124
        fi
        sleep 2; waited=$((waited + 2))
    done
    wait "$pid"
}

# final_answer ID  ->  prints the child's parsed final answer (mirrors parse.ts)
final_answer() {
    python3 - "$RUNTIME/runs/$1.log" <<'PY'
import json, sys
final = last = ""
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    s = line.strip()
    if not s or s[0] != "{":
        continue
    try:
        e = json.loads(s)
    except Exception:
        continue
    t = e.get("type")
    def text(m):
        c = (m or {}).get("content")
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return "".join(b.get("text", "") for b in c
                            if isinstance(b, dict) and b.get("type") == "text").strip()
        return ""
    if t == "agent_end":
        for m in reversed(e.get("messages", [])):
            if m.get("role") == "assistant" and text(m):
                final = text(m); break
    if t == "message_end":
        m = e.get("message", {})
        if m.get("role") == "assistant" and text(m):
            last = text(m)
print(final or last)
PY
}

# run_finished ID  ->  0 if the child reached a terminal event, 1 if cut off.
run_finished() {
    grep -qE '"type":"(agent_settled|agent_end)"' "$RUNTIME/runs/$1.log" 2>/dev/null
}

# require_finished LABEL ID RC  ->  prints INCOMPLETE and exits 2 if the run
# didn't finish (timeout/flake), so a cut-off run is never reported as a wrong
# answer. Returns 0 when the run completed.
require_finished() {
    local label="$1" id="$2" rc="$3"
    if [ "$rc" = 124 ] || ! run_finished "$id"; then
        echo "  INCOMPLETE: '$label' did not finish within ${TEST_TIMEOUT}s (model latency)."
        echo "             Re-run, or raise PI_SUBAGENT_TEST_TIMEOUT / set PI_SUBAGENT_TEST_MODEL."
        exit 2
    fi
}

# assert_contains LABEL TEXT PATTERN...  (all patterns must match, case-insensitive)
assert_contains() {
    local label="$1"; shift
    local text="$1"; shift
    local ok=1 pat
    for pat in "$@"; do
        if ! grep -qiE "$pat" <<<"$text"; then
            ok=0; echo "    ✗ expected to match: /$pat/"
        fi
    done
    if [ "$ok" = 1 ]; then echo "  PASS: $label"; return 0
    else echo "  FAIL: $label"; return 1; fi
}

test_banner() { echo; echo "=== $* ==="; echo "  model: $CHILD_MODEL  timeout: ${TEST_TIMEOUT}s"; }
