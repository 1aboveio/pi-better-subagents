/**
 * Characterization: detached child spawn with file-backed output — pinned
 * BEFORE the #39 sandbox prefactor. The prefactor must leave detached
 * execution, child argv order, and log capture untouched.
 *
 * Exercises the real spawn path (real child process, real log file); no
 * first-party seam is mocked. The child is detached + unref'd by design, so
 * each test holds a ref'd timer while awaiting the exit promise — otherwise
 * the test runner's event loop would drain before the child's close event.
 *
 * // @covers spawn.detached
 * // @level unit
 * // @characterizes spawn.detached
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnDetached } from '../spawn.ts';

describe('spawnDetached (characterization for #39)', () => {
    // @covers spawn.detached
    // @level unit
    // @characterizes spawn.detached
    it('spawns detached, streams stdout+stderr to the log, resolves the exit code', async () => {
        const base = mkdtempSync(join(tmpdir(), 'pi-spawn-char-'));
        const logPath = join(base, 'run.log');
        const keepAlive = setInterval(() => {}, 50);
        try {
            const { pid, exit } = spawnDetached({
                file: process.execPath,
                fileArgs: ['-e', 'console.log("marker-out"); console.error("marker-err")'],
                cwd: base,
                logPath,
            });
            assert.equal(typeof pid, 'number');
            assert.ok(pid > 0, 'detached child must have a real pid');
            const code = await exit;
            assert.equal(code, 0);
            const log = readFileSync(logPath, 'utf8');
            assert.ok(log.includes('marker-out'), `stdout must reach the log, got:\n${log}`);
            assert.ok(log.includes('marker-err'), `stderr must reach the log, got:\n${log}`);
        } finally {
            clearInterval(keepAlive);
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers spawn.detached
    // @level unit
    // @characterizes spawn.detached
    it('passes child argv through in order, elements intact', async () => {
        const base = mkdtempSync(join(tmpdir(), 'pi-spawn-char-'));
        const logPath = join(base, 'argv.log');
        const keepAlive = setInterval(() => {}, 50);
        try {
            const { exit } = spawnDetached({
                file: process.execPath,
                fileArgs: [
                    '-e', 'console.log(process.argv.slice(1).join("\\x1f"))',
                    'first with spaces', '"quoted"', '--flag', 'last',
                ],
                cwd: base,
                logPath,
            });
            assert.equal(await exit, 0);
            const log = readFileSync(logPath, 'utf8').trim();
            assert.equal(log, ['first with spaces', '"quoted"', '--flag', 'last'].join('\x1f'));
        } finally {
            clearInterval(keepAlive);
            rmSync(base, { recursive: true, force: true });
        }
    });
});
