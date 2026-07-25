/**
 * Complete Git remote semantics for disposable clone workspaces (issue #103).
 *
 * Proves the `git-remote-preservation` invariant that repeatedly blocked PR #89:
 * multiple `remote.<name>.pushurl` entries, whitespace local paths, multi-remote
 * sets, fetch-only remotes, and stale clone-only remote removal.
 *
 * // @covers git_remotes.read
 * // @level unit
 * // @covers git_remotes.sync
 * // @level unit
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitRemotes, syncGitRemotes } from "../git-remotes.ts";

function requireGit() {
    try {
        execFileSync("git", ["--version"], { stdio: "ignore" });
    } catch {
        throw new Error("git is required for git_remotes tests (no skip)");
    }
}

function runGit(cwd, args, opts = {}) {
    const argv = Array.isArray(args) ? args : args.split(/\s+/).filter(Boolean);
    try {
        return execFileSync("git", argv, {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            ...opts,
        }).trim();
    } catch (err) {
        const stderr = err?.stderr?.toString?.() ?? "";
        const stdout = err?.stdout?.toString?.() ?? "";
        throw new Error(
            `git ${argv.join(" ")} failed in ${cwd}: ${(err?.message ?? err)}\n${stdout}\n${stderr}`,
        );
    }
}

function real(p) {
    return realpathSync(p);
}

function initBare(path) {
    mkdirSync(path, { recursive: true });
    runGit(path, ["init", "--bare"]);
    return path;
}

function configureIdentity(path) {
    // CI runners have no global user.name/email; clones do not inherit the
    // source repo's local identity, so commits on the target would fail.
    runGit(path, ["config", "user.email", "test@example.com"]);
    runGit(path, ["config", "user.name", "Test"]);
}

function initRepo(path, { branch = "main" } = {}) {
    mkdirSync(path, { recursive: true });
    runGit(path, ["init"]);
    runGit(path, ["checkout", "-b", branch]);
    configureIdentity(path);
    writeFileSync(join(path, "a.txt"), "a\n");
    runGit(path, ["add", "a.txt"]);
    runGit(path, ["commit", "-m", "first"]);
    return path;
}

/** Clone `source` into `base/name` and configure a local commit identity. */
function cloneWithIdentity(base, source, name = "clone") {
    runGit(base, ["clone", source, name]);
    const target = join(base, name);
    configureIdentity(target);
    return target;
}

function pushUrlsAll(dir, remote = "origin") {
    return runGit(dir, ["remote", "get-url", "--push", "--all", remote])
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

function branchList(bareDir, name) {
    return runGit(bareDir, ["branch", "--list", name]);
}

before(() => {
    requireGit();
});

describe("git_remotes.read", () => {
    // @covers git_remotes.read
    // @level unit
    // @fails-without-fix git_remotes.read
    it("reads remotes from structured null-delimited git config, preserving whitespace URLs", () => {
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-ws-"));
        try {
            const fetchRemote = join(base, "up stream.git");
            const pushRemote = join(base, "push dest.git");
            const otherRemote = join(base, "other remote.git");
            initBare(fetchRemote);
            initBare(pushRemote);
            initBare(otherRemote);

            const repo = initRepo(join(base, "repo"));
            runGit(repo, ["remote", "add", "origin", fetchRemote]);
            runGit(repo, ["remote", "set-url", "--push", "origin", pushRemote]);
            runGit(repo, ["remote", "add", "upstream", otherRemote]);

            const model = readGitRemotes(repo);
            assert.deepEqual(
                model.map((r) => r.name).sort(),
                ["origin", "upstream"],
                "must not drop remotes whose URLs contain spaces",
            );

            const origin = model.find((r) => r.name === "origin");
            const upstream = model.find((r) => r.name === "upstream");
            assert.equal(origin.url, fetchRemote);
            assert.deepEqual(origin.pushUrls, [pushRemote]);
            assert.equal(upstream.url, otherRemote);
            assert.deepEqual(
                upstream.pushUrls,
                [],
                "fetch-only remote must not invent pushUrls",
            );
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.read
    // @level unit
    // @fails-without-fix git_remotes.read
    it("preserves every configured remote.<name>.pushurl (multi-pushurl model)", () => {
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-multi-push-"));
        try {
            const fetchRemote = join(base, "fetch.git");
            const push1 = join(base, "push one.git");
            const push2 = join(base, "push two.git");
            initBare(fetchRemote);
            initBare(push1);
            initBare(push2);

            const repo = initRepo(join(base, "repo"));
            runGit(repo, ["remote", "add", "origin", fetchRemote]);
            // Git replaces the default push target with the first --push set-url,
            // then --add --push appends further destinations.
            runGit(repo, ["remote", "set-url", "--push", "origin", push1]);
            runGit(repo, ["remote", "set-url", "--add", "--push", "origin", push2]);

            const configured = pushUrlsAll(repo, "origin");
            assert.equal(configured.length, 2, "fixture must configure two push URLs");
            assert.deepEqual(configured.map(real).sort(), [real(push1), real(push2)].sort());

            const model = readGitRemotes(repo);
            const origin = model.find((r) => r.name === "origin");
            assert.ok(origin, "origin must be present");
            assert.equal(real(origin.url), real(fetchRemote));
            assert.ok(Array.isArray(origin.pushUrls), "pushUrls must be an array");
            assert.equal(
                origin.pushUrls.length,
                2,
                "must keep BOTH pushurls — collapsing to one is the PR #89 blocker",
            );
            assert.deepEqual(
                origin.pushUrls.map(real).sort(),
                [real(push1), real(push2)].sort(),
                "must not drop, collapse, or rewrite multi-pushurl entries",
            );
            // Regression: must not rewrite push destinations to the fetch URL.
            for (const u of origin.pushUrls) {
                assert.notEqual(real(u), real(fetchRemote), "pushurl must stay distinct from fetch URL");
            }
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.read
    // @level unit
    it("returns empty pushUrls when no explicit pushurl is configured", () => {
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-fetch-only-"));
        try {
            const originBare = join(base, "origin.git");
            initBare(originBare);
            const repo = initRepo(join(base, "repo"));
            runGit(repo, ["remote", "add", "origin", originBare]);

            const origin = readGitRemotes(repo).find((r) => r.name === "origin");
            assert.ok(origin);
            assert.equal(real(origin.url), real(originBare));
            assert.deepEqual(origin.pushUrls, []);
            // Git default: get-url --push without explicit pushurl returns fetch URL.
            assert.equal(real(runGit(repo, ["remote", "get-url", "--push", "origin"])), real(originBare));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
});

describe("git_remotes.sync", () => {
    // @covers git_remotes.sync
    // @level unit
    // @fails-without-fix git_remotes.sync
    it("syncs multiple push URLs and proves pushes reach every destination", () => {
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-sync-multi-"));
        try {
            const fetchRemote = join(base, "fetch.git");
            const push1 = join(base, "push-a.git");
            const push2 = join(base, "push-b.git");
            initBare(fetchRemote);
            initBare(push1);
            initBare(push2);

            const source = initRepo(join(base, "source"));
            runGit(source, ["remote", "add", "origin", fetchRemote]);
            runGit(source, ["remote", "set-url", "--push", "origin", push1]);
            runGit(source, ["remote", "set-url", "--add", "--push", "origin", push2]);
            // Seed object availability on fetch remote is optional; pushes go to pushurls.
            runGit(source, ["push", "origin", "HEAD"]);

            // Simulate a path-style clone whose origin points at the parent working tree
            // and which may carry a single stale pushurl / extra remote.
            const target = cloneWithIdentity(base, source, "clone");
            // Path clone sets origin → source working tree. Add a stale remote too.
            runGit(target, ["remote", "add", "stale-only", join(base, "nowhere.git")]);
            // Give the clone a single wrong pushurl so sync must replace, not append-only.
            runGit(target, ["remote", "set-url", "--push", "origin", join(base, "wrong.git")]);

            syncGitRemotes(source, target);

            const cloneModel = readGitRemotes(target);
            assert.deepEqual(
                cloneModel.map((r) => r.name).sort(),
                ["origin"],
                "stale clone-only remotes must be removed",
            );
            const origin = cloneModel.find((r) => r.name === "origin");
            assert.equal(real(origin.url), real(fetchRemote), "fetch URL must match source");
            assert.equal(origin.pushUrls.length, 2, "both pushurls must be preserved on clone");
            assert.deepEqual(
                origin.pushUrls.map(real).sort(),
                [real(push1), real(push2)].sort(),
            );

            // Structured config on the clone must match Git's own multi-push view.
            assert.deepEqual(
                pushUrlsAll(target, "origin").map(real).sort(),
                [real(push1), real(push2)].sort(),
                "git remote get-url --push --all must list both destinations",
            );

            // Behavioral proof: one push reaches EVERY configured push destination.
            runGit(target, ["checkout", "-b", "multi-proof"]);
            writeFileSync(join(target, "proof.txt"), "proof\n");
            runGit(target, ["add", "proof.txt"]);
            runGit(target, ["commit", "-m", "multi-proof"]);
            runGit(target, ["push", "-u", "origin", "multi-proof"]);

            assert.match(
                branchList(push1, "multi-proof"),
                /multi-proof/,
                "push must land on first pushurl",
            );
            assert.match(
                branchList(push2, "multi-proof"),
                /multi-proof/,
                "push must land on second pushurl — keeping only the first is the blocker",
            );
            assert.equal(
                branchList(fetchRemote, "multi-proof"),
                "",
                "push must not land on the fetch-only remote when explicit pushurls exist",
            );
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.sync
    // @level unit
    it("preserves multiple remotes independently and removes stale clone-only remotes", () => {
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-multi-remote-"));
        try {
            const originBare = join(base, "origin.git");
            const mirrorBare = join(base, "mirror.git");
            initBare(originBare);
            initBare(mirrorBare);

            const source = initRepo(join(base, "source"));
            runGit(source, ["remote", "add", "origin", originBare]);
            runGit(source, ["remote", "add", "mirror", mirrorBare]);
            runGit(source, ["push", "-u", "origin", "HEAD"]);

            const target = cloneWithIdentity(base, source, "clone");
            // Path-style origin points at source; invent an extra remote.
            runGit(target, ["remote", "add", "extra", join(base, "extra.git")]);

            syncGitRemotes(source, target);

            const names = readGitRemotes(target).map((r) => r.name).sort();
            assert.deepEqual(names, ["mirror", "origin"]);
            assert.equal(real(runGit(target, ["remote", "get-url", "origin"])), real(originBare));
            assert.equal(real(runGit(target, ["remote", "get-url", "mirror"])), real(mirrorBare));
            assert.notEqual(
                real(runGit(target, ["remote", "get-url", "origin"])),
                real(source),
                "origin must not remain pointed at the parent working tree",
            );
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.sync
    // @level unit
    it("keeps fetch-only remotes semantically equivalent (no invented pushurl)", () => {
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-fetchonly-sync-"));
        try {
            const originBare = join(base, "origin.git");
            initBare(originBare);
            const source = initRepo(join(base, "source"));
            runGit(source, ["remote", "add", "origin", originBare]);
            runGit(source, ["push", "-u", "origin", "HEAD"]);

            const target = cloneWithIdentity(base, source, "clone");
            // Give the clone a leftover distinct pushurl that source does not have.
            const leftover = join(base, "leftover.git");
            initBare(leftover);
            runGit(target, ["remote", "set-url", "--push", "origin", leftover]);

            syncGitRemotes(source, target);

            const origin = readGitRemotes(target).find((r) => r.name === "origin");
            assert.deepEqual(origin.pushUrls, [], "must clear leftover pushurls");
            // Default Git push behavior: push URL equals fetch URL when no pushurl set.
            assert.equal(
                real(runGit(target, ["remote", "get-url", "--push", "origin"])),
                real(originBare),
            );

            runGit(target, ["checkout", "-b", "fetch-only-proof"]);
            writeFileSync(join(target, "proof.txt"), "p\n");
            runGit(target, ["add", "proof.txt"]);
            runGit(target, ["commit", "-m", "fetch-only-proof"]);
            runGit(target, ["push", "-u", "origin", "fetch-only-proof"]);
            assert.match(branchList(originBare, "fetch-only-proof"), /fetch-only-proof/);
            assert.equal(branchList(leftover, "fetch-only-proof"), "");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.sync
    // @level unit
    it("preserves whitespace local-path fetch and push URLs through sync", () => {
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-ws-sync-"));
        try {
            const fetchRemote = join(base, "up stream.git");
            const pushRemote = join(base, "push dest.git");
            initBare(fetchRemote);
            initBare(pushRemote);

            const source = initRepo(join(base, "source"));
            runGit(source, ["remote", "add", "origin", fetchRemote]);
            runGit(source, ["remote", "set-url", "--push", "origin", pushRemote]);
            runGit(source, ["push", "origin", "HEAD"]);

            const target = cloneWithIdentity(base, source, "clone");
            syncGitRemotes(source, target);

            assert.equal(runGit(target, ["remote", "get-url", "origin"]), fetchRemote);
            assert.equal(runGit(target, ["remote", "get-url", "--push", "origin"]), pushRemote);

            runGit(target, ["checkout", "-b", "ws-proof"]);
            writeFileSync(join(target, "proof.txt"), "proof\n");
            runGit(target, ["add", "proof.txt"]);
            runGit(target, ["commit", "-m", "ws-proof"]);
            runGit(target, ["push", "-u", "origin", "ws-proof"]);
            assert.match(branchList(pushRemote, "ws-proof"), /ws-proof/);
            assert.equal(branchList(fetchRemote, "ws-proof"), "");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
});

// Sanity: module file is the surface under test (exists once implemented).
describe("git_remotes module surface", () => {
    it("exports readGitRemotes and syncGitRemotes from git-remotes.ts", () => {
        assert.ok(existsSync(new URL("../git-remotes.ts", import.meta.url)));
        assert.equal(typeof readGitRemotes, "function");
        assert.equal(typeof syncGitRemotes, "function");
    });
});
