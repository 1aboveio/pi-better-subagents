/**
 * Complete first-class Git remote semantics for disposable clone workspaces.
 *
 * Invariant (`git-remote-preservation`, issue #103): disposable clone
 * preparation must preserve every source remote name, **every** configured
 * `remote.<name>.url` value, and **every** configured `remote.<name>.pushurl`
 * value — not just the first of either. Git permits multi-valued keys for both:
 *
 * - With no explicit pushurl, `git remote get-url --push --all` returns all
 *   fetch URLs and one `git push` reaches every URL.
 * - With explicit pushurl(s), push uses those destinations only.
 *
 * Collapsing either multi-valued set rewrites producer push/fetch topology.
 *
 * Values are read from null-delimited `git config` output rather than
 * `git remote -v` line parsing, which drops any URL containing spaces.
 *
 * Consumed by disposable clone workspace preparation (issue #78 / PR #89).
 */

import { execFileSync } from "node:child_process";

/** One configured Git remote, including every fetch URL and every explicit push URL. */
export interface GitRemote {
    name: string;
    /**
     * Every configured `remote.<name>.url`, in config order.
     * Git fetches from the first and, when no pushurl is set, pushes to all.
     */
    urls: string[];
    /**
     * Every configured `remote.<name>.pushurl`, in config order.
     * Empty when the remote has no explicit push URL (Git then pushes to every
     * entry in `urls`).
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
 * `remote.<name>.url` and **every** `remote.<name>.pushurl` entry (Git allows
 * multiple of each; multi-url with no pushurl is a multi-destination push set).
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

    const byName = new Map<string, { fetch: string[]; push: string[] }>();
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
        const entry = byName.get(name) ?? { fetch: [], push: [] };
        if (kind === "url") {
            // Preserve every fetch URL in config order — do not collapse to one.
            entry.fetch.push(value);
        } else {
            // Preserve every pushurl in config order — do not collapse to one.
            entry.push.push(value);
        }
        byName.set(name, entry);
    }

    const remotes: GitRemote[] = [];
    for (const [name, urls] of byName.entries()) {
        // Prefer configured fetch URLs. Unusual but legal: a remote with only
        // pushurl keys and no url key — expose the first pushurl as urls[0] so
        // the remote remains addressable, and keep the full push set in pushUrls.
        const fetchUrls =
            urls.fetch.length > 0
                ? [...urls.fetch]
                : urls.push.length > 0
                  ? [urls.push[0]]
                  : [];
        if (fetchUrls.length === 0) continue;
        remotes.push({
            name,
            urls: fetchUrls,
            pushUrls: [...urls.push],
        });
    }
    // Stable order by remote name so tests and sync are deterministic.
    remotes.sort((a, b) => a.name.localeCompare(b.name));
    return remotes;
}

/**
 * Make `targetDir`'s remotes match `sourceDir`'s complete remote contract:
 * names, every fetch URL, and every configured push URL. Removes stale remotes
 * that exist only on the target (typical after a path-style clone).
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
            // Create the remote with the first fetch URL, then apply the full sets.
            runGit(targetDir, ["remote", "add", remote.name, remote.urls[0]]);
            applyFetchUrls(targetDir, remote.name, remote.urls, [remote.urls[0]]);
        } else {
            applyFetchUrls(targetDir, remote.name, remote.urls, existing.urls);
        }

        applyPushUrls(targetDir, remote.name, remote.pushUrls, existing?.pushUrls ?? []);
    }
}

/**
 * Replace the target remote's fetch URL set with `desired`.
 *
 * Same multi-value constraint as pushurls: `git remote set-url <name> <url>`
 * fatals when the key already has multiple values. Always clear the complete
 * existing url set first (`git config --unset-all`), then rebuild with
 * set-url + --add. Never use regex `--delete` of URL text.
 */
function applyFetchUrls(
    dir: string,
    name: string,
    desired: string[],
    existing: string[],
): void {
    if (desired.length === 0) {
        throw new Error(`remote.${name} has no fetch URLs to apply in ${dir}`);
    }

    // Fast path: already identical in order — nothing to do.
    if (
        existing.length === desired.length &&
        existing.every((url, i) => url === desired[i])
    ) {
        return;
    }

    // Always clear the complete existing url set first. A bare `set-url`
    // cannot replace a multi-valued set (Git fatals).
    clearAllFetchUrls(dir, name);

    // Rebuild desired ordered set: first set-url, then --add.
    runGit(dir, ["remote", "set-url", name, desired[0]]);
    for (let i = 1; i < desired.length; i++) {
        runGit(dir, ["remote", "set-url", "--add", name, desired[i]]);
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
 * falls back to every configured fetch URL.
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
    clearAllPushUrls(dir, name);

    if (desired.length === 0) {
        // Desired is empty: after unset-all, Git's default (push → all fetch
        // URLs) holds. `get-url --push --all` reports fetch URL(s) when no
        // pushurl key exists, so treat remaining entries equal to fetch set
        // as already-default.
        const remaining = safePushUrlsAll(dir, name);
        const fetchUrls = safeFetchUrlsAll(dir, name);
        const isDefaultOnly =
            remaining.length === 0 ||
            (remaining.length === fetchUrls.length &&
                remaining.every((url, i) => url === fetchUrls[i]));
        if (isDefaultOnly) return;

        // Retry once if values somehow remain (should not happen after unset-all).
        clearAllPushUrls(dir, name);
        const still = safePushUrlsAll(dir, name);
        const stillDefaultOnly =
            still.length === 0 ||
            (still.length === fetchUrls.length &&
                still.every((url, i) => url === fetchUrls[i]));
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
 * Delete every configured fetch URL for `name` as a complete set.
 *
 * Must NOT use `git remote set-url --delete <name> <url>`: that treats the
 * final argument as a regex, so legal local paths containing unmatched
 * metacharacters (e.g. `[`) fail to match and leave stale destinations intact.
 * `git config --unset-all remote.<name>.url` drops the multi-valued key
 * wholesale without interpreting URL text as a pattern.
 *
 * Note: after unset-all the remote still exists (fetch refspec remains) but
 * has no url until rebuild. Callers must rebuild immediately.
 */
function clearAllFetchUrls(dir: string, name: string): void {
    try {
        runGit(dir, ["config", "--unset-all", `remote.${name}.url`]);
    } catch {
        // Key already absent (git exits non-zero) — nothing to clear.
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
function clearAllPushUrls(dir: string, name: string): void {
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

function safeFetchUrlsAll(dir: string, name: string): string[] {
    try {
        const out = runGit(dir, ["remote", "get-url", "--all", name]);
        return out
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}
