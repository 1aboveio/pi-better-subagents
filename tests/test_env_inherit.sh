#!/usr/bin/env bash
# Scenario 3: a subagent inherits the foreground environment — THROUGH the OS
# sandbox. This is the hardening test for the gh/GH_TOKEN class of problem: any
# credential a tool needs (GH_TOKEN, API keys) reaches the subagent via env, so
# keychain-free auth works headlessly.

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

test_banner "Scenario 3 — env inheritance through the sandbox"

# A unique marker set in THIS (foreground) shell; the child must see it.
export PI_ENV_MARKER="marker_$$_$(date +%s 2>/dev/null || echo x)"
echo "  marker: $PI_ENV_MARKER"

ID="test_env_$$"
WORK="$RUNTIME/work_$$"
# Sandboxed (writes confined to WORK) — proves env survives the sandbox wrapper.
run_child "$ID" "read,bash" \
    "Using the bash tool, run exactly: printenv PI_ENV_MARKER . Then report the value it printed on its own line, prefixed with SEEN=." \
    "$WORK"
rc=$?

require_finished "env inheritance" "$ID" "$rc"

ans="$(final_answer "$ID")"
echo "  --- subagent answer ---"
echo "$ans" | sed 's/^/    /' | head -8
echo "  -----------------------"

# The child must have printed back the exact marker value it inherited.
assert_contains "subagent inherited the foreground env var (through the sandbox)" \
    "$ans" "$PI_ENV_MARKER"
