#!/usr/bin/env bash
# Merge-queue integration suite — the expensive pre-merge gate.
#
# Runs the merge-queue gate tests:
#   1. macOS write-sandbox is applied (deterministic, no model)
#   2. sandboxed child cannot write outside sandbox_dir (deterministic)
#   3. extension tool web_fetch works in a scoped child
#   4. bash-scoped child can drive gh headlessly via GH_TOKEN
#   5. a child survives a parallel bash+read batch (#17 regression)
#
# (5) is the reason this gate exists at all: the failure it guards is a child
# that exits 0 mid-turn and is reported as completed. Silent success is exactly
# what a merge gate must not let back in, so it runs here, not just locally.
#
# The workflow runs the required Linux real-bwrap boundary test before this
# script. test_env_inherit.sh stays local-only (run_all.sh) — env-through-sandbox
# is covered there; this script retains the existing macOS platform-routed
# assertions plus the network/gh smokes.
#
# Usage:
#   tests/run_queue.sh
#   PI_SUBAGENT_TEST_MODEL=minimax-cn/MiniMax-M3 tests/run_queue.sh

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default to the same MiniMax-CN M3 config used in CI / local models.json.
export PI_SUBAGENT_TEST_MODEL="${PI_SUBAGENT_TEST_MODEL:-minimax-cn/MiniMax-M3}"

tests=(
    "$DIR/test_sandbox_applied.sh"
    "$DIR/test_sandbox_deny_outside.sh"
    "$DIR/test_web_fetch.sh"
    "$DIR/test_gh_issues.sh"
    "$DIR/test_headless_isolation.sh"
)
declare -a results
fail=0

for t in "${tests[@]}"; do
    bash "$t"
    rc=$?
    name="$(basename "$t")"
    case "$rc" in
        0) results+=("PASS        $name") ;;
        2) results+=("INCOMPLETE  $name  (flake — re-run)"); fail=1 ;;
        *) results+=("FAIL        $name"); fail=1 ;;
    esac
    # Breathe between tests so back-to-back model calls don't rate-limit.
    sleep 10
done

echo
echo "======== queue suite summary ========"
printf '%s\n' "${results[@]}"
echo "===================================="
exit "$fail"
