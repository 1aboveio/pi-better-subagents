#!/usr/bin/env bash
# Merge-queue integration suite — the expensive pre-merge gate.
#
# Runs the two tests that prove a real subagent can:
#   1. use an extension tool (web_fetch) against the network
#   2. drive gh headlessly via inherited GH_TOKEN
#
# The sandbox/env-inheritance test is intentionally excluded until Linux
# sandbox support lands (see issue #5). Run it locally via tests/run_all.sh.
#
# Usage:
#   tests/run_queue.sh
#   PI_SUBAGENT_TEST_MODEL=minimax-cn/MiniMax-M3 tests/run_queue.sh

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default to the same MiniMax-CN M3 config used in CI / local models.json.
export PI_SUBAGENT_TEST_MODEL="${PI_SUBAGENT_TEST_MODEL:-minimax-cn/MiniMax-M3}"

tests=("$DIR/test_web_fetch.sh" "$DIR/test_gh_issues.sh")
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
