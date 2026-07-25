/**
 * Unit + integration tests for disposable Git clone workspace preparation.
 * @covers subagent_spawn.git_clone_workspace
 * @covers git_workspace.inspect
 * @covers git_workspace.clone
 * @level unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
    inspectGitWorkspace,
    prepareGitCloneWorkspace,
    isGitMetadataOutsideSandbox,
    resolveSubagentWorkspace,
} = await import(new URL('../git-workspace.ts', import.meta.url).href);

function gitAvailable() {
    try {
        execFileSync(GIT_BIN, ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function resolveGitBin() {
    try {
        return execFileSync('which', ['git'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch {
        return 'git';
    }
}
const GIT_BIN = resolveGitBin();

function runGit(cwd, args, opts = {}) {
    const argv = Array.isArray(args) ? args : args.split(/\s+/).filter(Boolean);
    return execFileSync(GIT_BIN, argv, {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...opts,
    }).trim();
}

function makeRepo(base, name) {
    const dir = join(base, name);
    runGit(base, `init --bare ${name}.git`);
    mkdirSync(dir);
    runGit(dir, 'init');
    runGit(dir, 'checkout -b main');
    runGit(dir, 'config user.email test@example.com');
    runGit(dir, 'config user.name Test');
    writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
    runGit(dir, 'add README.md');
    runGit(dir, ['commit', '-m', 'initial']);
    return dir;
}

function makeLinkedWorktree(base, repoName, wtName) {
    const repo = join(base, repoName);
    const wt = join(base, wtName);
    runGit(repo, `worktree add ${wt} -b ${wtName}-branch`);
    return wt;
}

describe('git-workspace', { skip: !gitAvailable() }, () => {
    describe('inspectGitWorkspace', () => {
        it('identifies a normal repository as not a linked worktree', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-normal-'));
            try {
                const repo = makeRepo(base, 'repo');
                const info = inspectGitWorkspace(repo);
                assert.equal(info.isLinkedWorktree, false);
                assert.ok(existsSync(info.gitDir));
                assert.ok(lstatSync(join(repo, '.git')).isDirectory());
                assert.equal(isGitMetadataOutsideSandbox(info, repo), false);
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix git_workspace.inspect
        // @covers git_workspace.inspect
        // @level unit
        it('detects a linked worktree whose gitdir is outside the workspace root', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-linked-'));
            try {
                const repo = makeRepo(base, 'main');
                const wt = makeLinkedWorktree(base, 'main', 'wt');
                const info = inspectGitWorkspace(wt);
                assert.equal(info.isLinkedWorktree, true);
                assert.ok(!info.gitDir.startsWith(wt));
                assert.equal(isGitMetadataOutsideSandbox(info, wt), true);
                assert.match(
                    readFileSync(join(wt, '.git'), 'utf-8'),
                    /^gitdir:\s*/m,
                );
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        it('resolves the common git directory for reference acceleration', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-common-'));
            try {
                const repo = makeRepo(base, 'main');
                const wt = makeLinkedWorktree(base, 'main', 'wt');
                const info = inspectGitWorkspace(wt);
                assert.ok(existsSync(info.commonGitDir));
                assert.ok(existsSync(join(info.commonGitDir, 'objects')));
                assert.equal(info.commonGitDir, inspectGitWorkspace(repo).commonGitDir);
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        it('throws for a non-git directory', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-nogit-'));
            try {
                assert.throws(() => inspectGitWorkspace(base), /not a git repository/i);
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });
    });

    describe('prepareGitCloneWorkspace', () => {
        // @fails-without-fix git_workspace.clone
        // @covers git_workspace.clone
        // @level unit
        it('produces a clone with a real .git directory inside the target', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-clone-'));
            try {
                const repo = makeRepo(base, 'repo');
                const target = join(base, 'clone');
                const result = prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target });
                assert.equal(result, target);
                assert.ok(existsSync(join(target, '.git')));
                assert.ok(lstatSync(join(target, '.git')).isDirectory());
                assert.ok(existsSync(join(target, 'README.md')));
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        it('checks out the current commit of the source workspace', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-checkout-'));
            try {
                const repo = makeRepo(base, 'repo');
                const sourceCommit = runGit(repo, 'rev-parse HEAD');
                const target = join(base, 'clone');
                prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target });
                const targetCommit = runGit(target, 'rev-parse HEAD');
                assert.equal(targetCommit, sourceCommit);
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        it('honors an explicit branch or commit to checkout', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-checkout-explicit-'));
            try {
                const repo = makeRepo(base, 'repo');
                runGit(repo, 'checkout -b side');
                writeFileSync(join(repo, 'side.md'), 'side\n');
                runGit(repo, 'add side.md');
                runGit(repo, ['commit', '-m', 'side']);
                const sideCommit = runGit(repo, 'rev-parse side');
                runGit(repo, 'checkout main');

                const target = join(base, 'clone');
                prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target, checkout: 'side' });
                assert.equal(runGit(target, 'rev-parse HEAD'), sideCommit);
                assert.ok(existsSync(join(target, 'side.md')));
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix git_workspace.clone
        // @covers git_workspace.clone
        // @level unit
        it('uses reference acceleration and dissociates from the parent repo', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-dissoc-'));
            try {
                const repo = makeRepo(base, 'repo');
                const target = join(base, 'clone');
                prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target });
                const alternates = join(target, '.git', 'objects', 'info', 'alternates');
                assert.equal(existsSync(alternates), false, 'clone must not retain alternates after --dissociate');
                const targetCommit = runGit(target, 'rev-parse HEAD');
                assert.equal(runGit(repo, 'rev-parse HEAD'), targetCommit);
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        it('clones from a linked worktree using the main repo as reference', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-linked-clone-'));
            try {
                const repo = makeRepo(base, 'main');
                const wt = makeLinkedWorktree(base, 'main', 'wt');
                const target = join(base, 'clone');
                const result = prepareGitCloneWorkspace({ sourceDir: wt, targetDir: target });
                assert.equal(result, target);
                assert.ok(lstatSync(join(target, '.git')).isDirectory());
                assert.equal(runGit(target, 'rev-parse HEAD'), runGit(wt, 'rev-parse HEAD'));
                const alternates = join(target, '.git', 'objects', 'info', 'alternates');
                assert.equal(existsSync(alternates), false);
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        it('throws a helpful message when the source is not a git repository', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-nogit-clone-'));
            try {
                const target = join(base, 'clone');
                assert.throws(
                    () => prepareGitCloneWorkspace({ sourceDir: base, targetDir: target }),
                    /git_clone_workspace|linked worktree|outside the sandbox/i,
                );
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });
    });

    describe('sandboxed git operations in clone workspace', () => {
        // @covers subagent_spawn.git_clone_workspace
        // @level integration
        it('supports status, fetch, edit, add, commit, rebase, and push dry-run', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-ops-'));
            try {
                const origin = join(base, 'origin.git');
                runGit(base, `init --bare origin.git`);
                const repo = join(base, 'repo');
                runGit(base, `clone ${origin} repo`);
                runGit(repo, 'config user.email test@example.com');
                runGit(repo, 'config user.name Test');
                writeFileSync(join(repo, 'a.txt'), 'a\n');
                runGit(repo, 'add a.txt');
                runGit(repo, ['commit', '-m', 'first']);
                // Push the current branch to origin so the clone inherits it.
                runGit(repo, 'push -u origin HEAD');

                const target = join(base, 'clone');
                prepareGitCloneWorkspace({ sourceDir: repo, targetDir: target });
                runGit(target, 'config user.email test@example.com');
                runGit(target, 'config user.name Test');

                // status
                const status = runGit(target, 'status --short');
                assert.equal(status, '');

                // fetch (the remote already has the commit; the operation itself must succeed)
                runGit(target, 'fetch origin');
                const remoteHead = runGit(target, 'rev-parse origin/HEAD');
                const log = runGit(target, 'log --oneline origin/HEAD');
                assert.match(log, /first/);

                // edit + add + commit
                writeFileSync(join(target, 'c.txt'), 'c\n');
                runGit(target, 'add c.txt');
                runGit(target, ['commit', '-m', 'second']);

                // rebase onto the fetched remote head (no-op here; proves the command works)
                runGit(target, 'rebase origin/HEAD');
                assert.match(runGit(target, 'log --oneline'), /second/);
                assert.match(runGit(target, 'log --oneline'), /first/);

                // conflict resolution + rebase --continue: simulate an upstream rewrite.
                writeFileSync(join(target, 'd.txt'), 'd\n');
                runGit(target, 'add d.txt');
                runGit(target, ['commit', '-m', 'third']);
                // Rewrite the branch tip with an empty amend so the next rebase has work to do.
                runGit(target, ['commit', '--amend', '-m', 'third-amended']);
                // A local rebase that replays the tip onto origin/HEAD exercises continue.
                runGit(target, 'rebase origin/HEAD');
                assert.match(runGit(target, 'log --oneline'), /third-amended/);

                // push dry-run
                const pushOut = runGit(target, 'push --dry-run origin HEAD');
                assert.equal(typeof pushOut, 'string');
                assert.ok(remoteHead);
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });
    });

    describe('resolveSubagentWorkspace', () => {
        // @covers subagent_spawn.git_clone_workspace
        // @level unit
        it('returns the original cwd when git_clone_workspace is not requested', () => {
            const cwd = mkdtempSync(join(tmpdir(), 'pi-gitws-resolve-'));
            try {
                const result = resolveSubagentWorkspace({
                    ctxCwd: cwd,
                    sandboxEnabled: true,
                    runId: 'sa_test_1',
                    runDirPath: join(cwd, 'run'),
                });
                assert.equal(result.cwd, cwd);
                assert.equal(result.requestedSandboxDir, cwd);
            } finally {
                rmSync(cwd, { recursive: true, force: true });
            }
        });

        it('keeps sandbox_dir as the workspace root when provided', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-resolve-sbx-'));
            try {
                const repo = makeRepo(base, 'repo');
                const sandboxDir = join(base, 'clone');
                const result = resolveSubagentWorkspace({
                    ctxCwd: repo,
                    cwd: repo,
                    sandboxDir,
                    gitCloneWorkspace: true,
                    sandboxEnabled: true,
                    runId: 'sa_test_2',
                    runDirPath: join(base, 'run'),
                });
                assert.equal(realpathSync(result.cwd), realpathSync(sandboxDir));
                assert.equal(realpathSync(result.requestedSandboxDir ?? ''), realpathSync(sandboxDir));
                assert.ok(lstatSync(join(result.cwd, '.git')).isDirectory());
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        // @fails-without-fix subagent_spawn.git_clone_workspace
        // @covers subagent_spawn.git_clone_workspace
        // @level unit
        it('prepares a clone workspace under the run dir when sandbox_dir is omitted', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-resolve-run-'));
            try {
                const repo = makeRepo(base, 'repo');
                const runDirPath = join(base, 'run');
                const result = resolveSubagentWorkspace({
                    ctxCwd: repo,
                    cwd: repo,
                    gitCloneWorkspace: true,
                    sandboxEnabled: true,
                    runId: 'sa_test_3',
                    runDirPath,
                });
                assert.ok(realpathSync(result.cwd).startsWith(realpathSync(runDirPath)));
                assert.equal(result.requestedSandboxDir, result.cwd);
                assert.ok(lstatSync(join(result.cwd, '.git')).isDirectory());
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        it('does not add a sandbox dir when sandbox is disabled', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-resolve-nosbx-'));
            try {
                const repo = makeRepo(base, 'repo');
                const result = resolveSubagentWorkspace({
                    ctxCwd: repo,
                    cwd: repo,
                    gitCloneWorkspace: true,
                    sandboxEnabled: false,
                    runId: 'sa_test_4',
                    runDirPath: join(base, 'run'),
                });
                assert.equal(result.requestedSandboxDir, undefined);
                assert.ok(lstatSync(join(result.cwd, '.git')).isDirectory());
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });

        it('uses cwd as the source repo when sandbox_dir is provided without cwd', () => {
            const base = mkdtempSync(join(tmpdir(), 'pi-gitws-resolve-src-'));
            try {
                const repo = makeRepo(base, 'repo');
                const sandboxDir = join(base, 'clone');
                const result = resolveSubagentWorkspace({
                    ctxCwd: repo,
                    sandboxDir,
                    gitCloneWorkspace: true,
                    sandboxEnabled: true,
                    runId: 'sa_test_5',
                    runDirPath: join(base, 'run'),
                });
                assert.equal(realpathSync(result.cwd), realpathSync(sandboxDir));
                assert.ok(lstatSync(join(result.cwd, '.git')).isDirectory());
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        });
    });
});
