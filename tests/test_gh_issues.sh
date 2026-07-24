#!/usr/bin/env bash
# Scenario 2: a subagent uses gh (via bash) to list issues of 1aboveio/.github.
# Proves a bash-scoped child can drive an external CLI and report structured info.

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

test_banner "Scenario 2 — gh issue list (1aboveio/.github)"

# gh authenticates via the macOS keychain by default. A spawned/headless child
# touching the keychain can trigger a prompt it can't answer, so gh may hang.
# Passing a token in GH_TOKEN bypasses the keychain; the child inherits this env.
# (Product note: real subagents using gh want GH_TOKEN in the foreground pi's env.)
if [ -z "${GH_TOKEN:-}" ] && command -v gh >/dev/null; then
    export GH_TOKEN="$(gh auth token 2>/dev/null)"
fi
if [ -z "${GH_TOKEN:-}" ]; then
    echo "  SKIP: no GH_TOKEN and 'gh auth token' unavailable — cannot run gh headlessly."
    exit 0
fi

ID="test_ghissues_$$"
# Use --json/--jq so the command ALWAYS prints a number (0 when there are no
# issues). Plain `gh issue list` prints nothing on an empty repo, which the model
# misreads as an error and then loops investigating.
run_child "$ID" "read,bash" \
    "Run this exact bash command with no extra arguments or trailing punctuation:
gh issue list -R 1aboveio/.github --state open --json number --jq length
It prints the number of open issues (0 means none — a valid answer, not an error). Then report the count in one sentence like: There are N open issues in 1aboveio/.github"
rc=$?

require_finished "gh issue list" "$ID" "$rc"

ans="$(final_answer "$ID")"
echo "  --- subagent answer ---"
echo "$ans" | sed 's/^/    /' | head -15
echo "  -----------------------"
[ -z "$ans" ] && { echo "  FAIL: run finished but produced no answer"; exit 1; }

# The repo currently has no open issues, so a successful gh run reports exactly
# that. Assert the subagent ran gh and reported a concrete issue status.
assert_contains "ran gh and reported issue status for the repo" "$ans" \
    "issue" "no open|none|zero|[0-9]+ open|1aboveio|\.github"
