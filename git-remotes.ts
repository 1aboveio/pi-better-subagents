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
 * Git has no "set all pushurls" primitive: the first `set-url --push` replaces
 * the entire push set with one URL; subsequent `--add --push` append. When the
 * desired set is empty, every existing pushurl is deleted so push falls back
 * to the fetch URL.
 */
function applyPushUrls(
    dir: string,
    name: string,
    desired: string[],
    existing: string[],
): void {
    if (desired.length === 0) {
        // Clear every leftover pushurl so Git's default (push → fetch URL) holds.
        for (const url of existing) {
            try {
                runGit(dir, ["remote", "set-url", "--push", "--delete", name, url]);
            } catch {
                // Older Git / already-removed entry: ignore and continue.
            }
        }
        // If anything remains (e.g. --delete unsupported), force push URL = fetch URL
        // by reading the fetch URL and setting a single matching push URL, then
        // only if push still differs. Prefer leaving Git default when possible.
        const remaining = safePushUrlsAll(dir, name);
        const fetchUrl = safeFetchUrl(dir, name);
        if (remaining.length > 0 && fetchUrl) {
            // Replace multi-set with fetch URL (semantically equivalent to no pushurl
            // for push destination purposes when only one URL remains equal to fetch).
            runGit(dir, ["remote", "set-url", "--push", name, fetchUrl]);
            // If Git still lists a distinct pushurl equal to fetch, try delete once.
            try {
                runGit(dir, ["remote", "set-url", "--push", "--delete", name, fetchUrl]);
            } catch {
                // Accept pushurl == fetch as default-equivalent.
            }
        }
        return;
    }

    // Fast path: already identical in order.
    if (
        existing.length === desired.length &&
        existing.every((url, i) => url === desired[i])
    ) {
        return;
    }

    // Replace: first set-url --push replaces the whole push set; then add the rest.
    runGit(dir, ["remote", "set-url", "--push", name, desired[0]]);
    for (let i = 1; i < desired.length; i++) {
        runGit(dir, ["remote", "set-url", "--add", "--push", name, desired[i]]);
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
