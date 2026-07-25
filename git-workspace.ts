/**
 * Disposable Git clone workspace preparation for sandboxed subagents.
 *
 * Sandboxed subagents that need to mutate Git cannot safely run in a linked
 * Git worktree: the worktree's `.git` file points back to administrative state
 * under the main repository, outside the sandbox writable root. This module
 * prepares a self-contained clone whose `.git/` directory lives inside the
 * sandbox root.
 *
 * Preferred clone strategy:
 *   git clone --reference-if-able <local-reference-repo> --dissociate \
 *             <remote-url> <sandbox-workspace>
 *
 * --reference-if-able borrows local objects during setup; --dissociate makes
 * the resulting clone independent of the reference repository afterwards.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface GitWorkspaceInfo {
    /** Absolute path to the working tree root. */
    repoRoot: string;
    /** Absolute path to the git directory for this working tree. */
    gitDir: string;
    /** Absolute path to the common git directory containing the object database. */
    commonGitDir: string;
    /** True when this working tree is a linked worktree (its `.git` is a file). */
    isLinkedWorktree: boolean;
}

function runGit(cwd: string, args: string[], opts?: { encoding?: BufferEncoding; stdio?: any }): string {
    try {
        return execFileSync("git", args, {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            ...opts,
        }).trim();
    } catch (err) {
        const message = (err as Error).message ?? String(err);
        throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${message}`);
    }
}

/** Resolve `path` to an absolute, real path. Falls back to resolve() if the path does not exist. */
function realPath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

/**
 * Inspect a directory that is expected to be a Git working tree.
 *
 * Returns whether the directory is a linked worktree and where its Git
 * metadata lives. Throws if the directory is not inside a Git repository.
 */
export function inspectGitWorkspace(dir: string): GitWorkspaceInfo {
    const repoRoot = runGit(dir, ["rev-parse", "--show-toplevel"]);
    const gitDir = runGit(dir, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const commonGitDir = runGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

    const gitDot = resolve(repoRoot, ".git");
    const isLinkedWorktree = existsSync(gitDot) && !lstatSync(gitDot).isDirectory();

    return {
        repoRoot: realPath(repoRoot),
        gitDir: realPath(gitDir),
        commonGitDir: realPath(commonGitDir),
        isLinkedWorktree,
    };
}

/** True when the Git metadata for `info` lives outside `sandboxRoot`. */
export function isGitMetadataOutsideSandbox(info: GitWorkspaceInfo, sandboxRoot: string): boolean {
    const root = realPath(sandboxRoot);
    const gitDir = info.gitDir;
    // Outside means the git dir is not the sandbox root itself and does not
    // start with the sandbox root followed by a path separator.
    if (gitDir === root) return false;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return !gitDir.startsWith(prefix);
}

function readCurrentCommit(dir: string): string {
    return runGit(dir, ["rev-parse", "HEAD"]);
}

function readCurrentBranchOrCommit(dir: string): string {
    try {
        const branch = runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
        if (branch !== "HEAD") return branch;
    } catch {
        // Detached HEAD; fall back to commit.
    }
    return readCurrentCommit(dir);
}

export interface SubagentWorkspaceOptions {
    /** Current working directory from the extension context. */
    ctxCwd: string;
    /** Per-call cwd override. */
    cwd?: string;
    /** Per-call sandbox_dir override. */
    sandboxDir?: string;
    /** Whether the caller requested a disposable Git clone workspace. */
    gitCloneWorkspace?: boolean;
    /** Run id, used to build a workspace path under the run directory. */
    runId: string;
    /** Absolute path to the run directory for this subagent. */
    runDirPath: string;
    /** Whether the OS sandbox is enabled for this subagent. */
    sandboxEnabled: boolean;
}

export interface SubagentWorkspace {
    /** Working directory the child should run in. */
    cwd: string;
    /** Sandbox writable root, when sandboxing is enabled. */
    requestedSandboxDir?: string;
}

/**
 * Resolve the subagent's working directory and sandbox root.
 *
 * When `gitCloneWorkspace` is true, the source workspace is cloned into a
 * disposable, self-contained Git workspace under the sandbox root. This keeps
 * Git metadata inside the writable sandbox directory for Git-mutating
 * subagents.
 */
export function resolveSubagentWorkspace(options: SubagentWorkspaceOptions): SubagentWorkspace {
    let cwd = options.sandboxDir ?? options.cwd ?? options.ctxCwd;
    let requestedSandboxDir: string | undefined = options.sandboxEnabled
        ? (options.sandboxDir ?? cwd)
        : undefined;

    if (options.gitCloneWorkspace) {
        const sourceDir = options.cwd ?? options.ctxCwd;
        const cloneTarget = options.sandboxDir ?? join(options.runDirPath, "workspace");
        mkdirSync(cloneTarget, { recursive: true });
        cwd = prepareGitCloneWorkspace({ sourceDir, targetDir: cloneTarget });
        if (options.sandboxEnabled) {
            requestedSandboxDir = cwd;
        }
    }

    return { cwd, requestedSandboxDir };
}

export interface PrepareGitCloneWorkspaceOptions {
    /** Directory of the source working tree to clone. */
    sourceDir: string;
    /** Directory to clone into. Created if missing. */
    targetDir: string;
    /**
     * Branch or commit to checkout after cloning. Defaults to the source's
     * current branch/commit.
     */
    checkout?: string;
}

/**
 * Prepare a disposable, self-contained Git clone workspace for a sandboxed
 * subagent that will mutate Git.
 *
 * The returned directory is a full Git working tree with a real `.git/`
 * directory inside it. No live alternates link to the parent repo remains.
 */
export function prepareGitCloneWorkspace(options: PrepareGitCloneWorkspaceOptions): string {
    const sourceDir = realPath(options.sourceDir);
    const targetDir = realPath(options.targetDir);

    let info: GitWorkspaceInfo;
    try {
        info = inspectGitWorkspace(sourceDir);
    } catch (err) {
        throw new Error(
            `git_clone_workspace requires a Git repository. ${(err as Error).message}`,
        );
    }

    if (info.isLinkedWorktree && isGitMetadataOutsideSandbox(info, sourceDir)) {
        // A linked worktree's `.git` pointer references metadata outside the
        // source directory. The only safe path is to prepare a writable clone.
        // If we cannot, fail fast rather than launch into a broken sandbox.
        if (!existsSync(info.commonGitDir) || !lstatSync(info.commonGitDir).isDirectory()) {
            throw linkedWorktreeError(sourceDir);
        }
    }

    mkdirSync(targetDir, { recursive: true });

    // Use the common git directory as the local reference so linked worktrees
    // benefit from object sharing with the main repository.
    const referenceRepo = info.commonGitDir;
    const checkout = options.checkout ?? readCurrentBranchOrCommit(sourceDir);

    // Clone from the source repo root. --reference-if-able is a best-effort
    // acceleration: if the reference repo is unavailable, Git falls back to a
    // normal clone. --dissociate removes the alternates link after setup.
    const cloneArgs = [
        "clone",
        "--reference-if-able", referenceRepo,
        "--dissociate",
        info.repoRoot,
        targetDir,
    ];

    try {
        runGit(dirname(targetDir), cloneArgs, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
        if (info.isLinkedWorktree) {
            throw linkedWorktreeError(sourceDir);
        }
        throw err;
    }

    // Checkout the requested ref. Git already checked out the source's current
    // default branch in a standard clone; this makes the branch/commit explicit
    // and supports detached-HEAD source states.
    try {
        runGit(targetDir, ["checkout", checkout]);
    } catch (err) {
        throw new Error(
            `git_clone_workspace could not checkout ${checkout}: ${(err as Error).message}`,
        );
    }

    // Verify the clone is self-contained.
    const cloneDotGit = resolve(targetDir, ".git");
    if (!existsSync(cloneDotGit) || !lstatSync(cloneDotGit).isDirectory()) {
        throw new Error(
            `git_clone_workspace produced a workspace without a real .git directory at ${cloneDotGit}`,
        );
    }
    const alternates = resolve(cloneDotGit, "objects", "info", "alternates");
    if (existsSync(alternates)) {
        throw new Error(
            `git_clone_workspace left a live alternates link at ${alternates}; clone is not self-contained`,
        );
    }

    return targetDir;
}

function linkedWorktreeError(sourceDir: string): Error {
    return new Error(
        `Linked worktree at ${sourceDir} has Git metadata outside the sandbox. ` +
        `Use git_clone_workspace:true to request a disposable clone workspace ` +
        `so the subagent can mutate Git safely.`,
    );
}

/**
 * Verify that a sandboxed Git-mutating request will not launch into a linked
 * worktree whose metadata lives outside the sandbox root.
 *
 * When the caller has explicitly requested a clone workspace, the workspace
 * will be converted; this guard is for callers that requested Git mutation
 * without clone preparation.
 */
export function assertSafeGitWorkspace(workspaceDir: string, sandboxRoot: string): void {
    const info = inspectGitWorkspace(workspaceDir);
    if (info.isLinkedWorktree && isGitMetadataOutsideSandbox(info, sandboxRoot)) {
        throw linkedWorktreeError(workspaceDir);
    }
}
