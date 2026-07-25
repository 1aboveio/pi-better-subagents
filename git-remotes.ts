/**
 * Complete first-class Git remote semantics for disposable clone workspaces.
 *
 * Invariant (`git-remote-preservation`, issue #103): disposable clone
 * preparation must preserve every source remote name, its fetch URL(s), and
 * **all** configured `remote.<name>.pushurl` values — not just the first.
 * Git pushes to every configured push destination; collapsing multi-pushurl
 * sets rewrites producer push topology.
 *
 * Values are read from null-delimited `git config` output rather than
 * `git remote -v` line parsing, which drops any URL containing spaces.
 *
 * Consumed by disposable clone workspace preparation (issue #78 / PR #89).
 */

import { execFileSync } from "node:child_process";

/** One configured Git remote, including every explicit push URL. */
export interface GitRemote {
    name: string;
    /** Fetch URL (`remote.<name>.url`). Falls back to the first pushurl only if no fetch URL exists. */
    url: string;
    /**
     * Every configured `remote.<name>.pushurl`, in config order.
     * Empty when the remote has no explicit push URL (Git then pushes to `url`).
     */
    pushUrls: string[];
}

function runGit(cwd: string, args: string[]): string {
    try {
        return execFileSync("git", args, {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch (err) {
        const message = (err as Error).message ?? String(err);
        throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${message}`);
    }
}

/**
 * Read remote fetch/push URLs from structured Git config.
 *
 * Uses `git config --null --get-regexp` so URL values may contain spaces, tabs,
 * or other whitespace without being truncated. Collects **every**
 * `remote.<name>.pushurl` entry (Git allows multiple and pushes to all).
 */
export function readGitRemotes(dir: string): GitRemote[] {
    let raw: string;
    try {
        // Call git directly (not runGit) so we do not .trim() away trailing
        // structure from null-delimited config output.
        raw = execFileSync(
            "git",
            ["config", "--null", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"],
            {
                cwd: dir,
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
    } catch {
        // No remotes configured (git exits 1) or config unreadable.
        return [];
    }
    if (!raw) return [];

    const byName = new Map<string, { fetch?: string; push: string[] }>();
    for (const record of raw.split("\0")) {
        if (!record) continue;
        const nl = record.indexOf("\n");
        if (nl < 0) continue;
        const key = record.slice(0, nl);
        const value = record.slice(nl + 1);
        // Empty values are not meaningful remote URLs; skip.
        if (value === "") continue;

        // remote.<name>.url | remote.<name>.pushurl — name may itself contain dots.
        const match = key.match(/^remote\.(.+)\.(url|pushurl)$/);
        if (!match) continue;
        const [, name, kind] = match;
        const entry = byName.get(name) ?? { push: [] };
        if (kind === "url") {
            // First configured fetch URL wins (matches git remote get-url).
            if (entry.fetch === undefined) entry.fetch = value;
        } else {
            // Preserve every pushurl in config order — do not collapse to one.
            entry.push.push(value);
        }
        byName.set(name, entry);
    }

    const remotes: GitRemote[] = [];
    for (const [name, urls] of byName.entries()) {
        // Prefer the fetch URL as the canonical remote URL; fall back to the
        // first pushurl only when no fetch entry exists (unusual but legal).
        const url = urls.fetch ?? urls.push[0];
        if (!url) continue;
        remotes.push({
            name,
            url,
            pushUrls: [...urls.push],
        });
    }
    // Stable order by remote name so tests and sync are deterministic.
    remotes.sort((a, b) => a.name.localeCompare(b.name));
    return remotes;
}

/**
 * Make `targetDir`'s remotes match `sourceDir`'s complete remote contract:
 * names, fetch URLs, and every configured push URL. Removes stale remotes that
 * exist only on the target (typical after a path-style clone).
 */
export function syncGitRemotes(sourceDir: string, targetDir: string): void {
    const sourceRemotes = readGitRemotes(sourceDir);
    const targetRemotes = readGitRemotes(targetDir);
    const sourceNames = new Set(sourceRemotes.map((remote) => remote.name));

    // Drop remotes the source does not have (typical case: clone-from-path set
    // origin to the parent working tree, or leftover scratch remotes).
    for (const remote of targetRemotes) {
        if (!sourceNames.has(remote.name)) {
            runGit(targetDir, ["remote", "remove", remote.name]);
        }
    }

    for (const remote of sourceRemotes) {
        const existing = targetRemotes.find((entry) => entry.name === remote.name);
        if (!existing) {
            runGit(targetDir, ["remote", "add", remote.name, remote.url]);
        } else if (existing.url !== remote.url) {
            runGit(targetDir, ["remote", "set-url", remote.name, remote.url]);
        }

        applyPushUrls(targetDir, remote.name, remote.pushUrls, existing?.pushUrls ?? []);
    }
}

/**
 * Replace the target remote's push URL set with `desired`.
 *
 * Git has no "set all pushurls" primitive. Critically, `git remote set-url
 * --push <name> <url>` is rejected when the target already has multiple
 * pushurl values (`warning: remote.<name>.pushurl has multiple values;
 * fatal: could not set ...`). Always clear the complete existing pushurl
 * set first, then rebuild the desired ordered set with set-url + --add.
 * When the desired set is empty, every existing pushurl is deleted so push
 * falls back to the fetch URL.
 */
function applyPushUrls(
    dir: string,
    name: string,
    desired: string[],
    existing: string[],
): void {
    // Fast path: already identical in order — nothing to do (desired empty or not).
    if (
        existing.length === desired.length &&
        existing.every((url, i) => url === desired[i])
    ) {
        return;
    }

    // Always clear the complete existing pushurl set first. A bare
    // `set-url --push` cannot replace a multi-valued set (Git fatals).
    clearAllPushUrls(dir, name, existing);

    if (desired.length === 0) {
        // Desired is empty: after unset-all, Git's default (push → fetch URL) holds.
        // `get-url --push --all` reports the fetch URL when no pushurl key exists,
        // so treat a single remaining entry equal to fetch as already-default.
        const remaining = safePushUrlsAll(dir, name);
        const fetchUrl = safeFetchUrl(dir, name);
        const isDefaultOnly =
            remaining.length === 0 ||
            (remaining.length === 1 && fetchUrl !== undefined && remaining[0] === fetchUrl);
        if (isDefaultOnly) return;

        // Retry once if values somehow remain (should not happen after unset-all).
        clearAllPushUrls(dir, name, remaining);
        const still = safePushUrlsAll(dir, name);
        const stillDefaultOnly =
            still.length === 0 ||
            (still.length === 1 && fetchUrl !== undefined && still[0] === fetchUrl);
        if (!stillDefaultOnly) {
            throw new Error(
                `unable to clear multi-valued remote.${name}.pushurl in ${dir}`,
            );
        }
        return;
    }

    // Rebuild desired ordered set: first set-url --push, then --add --push.
    // Safe now because the multi-valued set was cleared above.
    runGit(dir, ["remote", "set-url", "--push", name, desired[0]]);
    for (let i = 1; i < desired.length; i++) {
        runGit(dir, ["remote", "set-url", "--add", "--push", name, desired[i]]);
    }
}

/**
 * Delete every configured pushurl for `name` as a complete set.
 *
 * Must NOT use `git remote set-url --push --delete <name> <url>`: that treats
 * the final argument as a regex, so legal local paths containing unmatched
 * metacharacters (e.g. `[`) fail to match and leave stale destinations intact.
 * `git config --unset-all remote.<name>.pushurl` drops the multi-valued key
 * wholesale without interpreting URL text as a pattern.
 */
function clearAllPushUrls(dir: string, name: string, _urls: string[] = []): void {
    try {
        runGit(dir, ["config", "--unset-all", `remote.${name}.pushurl`]);
    } catch {
        // Key already absent (git exits non-zero) — nothing to clear.
    }
}

function safePushUrlsAll(dir: string, name: string): string[] {
    try {
        const out = runGit(dir, ["remote", "get-url", "--push", "--all", name]);
        return out
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

function safeFetchUrl(dir: string, name: string): string | undefined {
    try {
        return runGit(dir, ["remote", "get-url", name]);
    } catch {
        return undefined;
    }
}
