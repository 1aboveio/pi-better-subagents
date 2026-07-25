/**
 * Unit: sandbox.ts profile matches the confinement contract used by subagents.
 *
 * Import-strict on purpose (issue #39, AC5): the product sandbox module is
 * imported statically at module load, so if it cannot be imported or loaded
 * this file FAILS. The previous dynamic-import + catch reported a vacuous
 * "skips when sandbox.ts cannot be imported" pass; an import failure must
 * never produce a passing suite.
 *
 * @covers sandbox-profile
 * @level unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxSupported, buildSandboxCommand } from '../sandbox.ts';

describe('sandbox profile (subagent write confinement)', () => {
    it('sandboxSupported is true only on darwin', () => {
        assert.equal(typeof sandboxSupported(), 'boolean');
        if (process.platform === 'darwin') assert.equal(sandboxSupported(), true);
        else assert.equal(sandboxSupported(), false);
    });

    it('buildSandboxCommand writes deny-all-writes then allow sandbox_dir', () => {
        const base = mkdtempSync(join(tmpdir(), 'pi-sbx-unit-'));
        const writable = join(base, 'work');
        const profilePath = join(base, 'profile.sb');
        mkdirSync(writable, { recursive: true });
        try {
            const cmd = buildSandboxCommand({
                profilePath,
                writableDir: writable,
                home: join(base, 'home'),
                piBin: '/usr/bin/true',
                piArgs: ['-p'],
            });
            assert.equal(cmd.file, '/usr/bin/sandbox-exec');
            assert.ok(cmd.fileArgs.includes('-f'));
            assert.ok(cmd.fileArgs.includes(profilePath));
            assert.ok(cmd.fileArgs.includes('/usr/bin/true'));

            const body = readFileSync(profilePath, 'utf8');
            assert.match(body, /\(version 1\)/);
            assert.match(body, /\(allow default\)/);
            assert.match(body, /\(deny file-write\*\)/);

            const resolved = realpathSync(writable);
            assert.ok(
                body.includes(`(allow file-write* (subpath "${resolved}"))`),
                `profile must allow resolved writable dir ${resolved}, got:\n${body}`,
            );
            assert.match(body, /\/private\/var\/folders/);
            assert.match(body, /\/private\/tmp/);
            assert.match(body, /\/dev/);
            // home/.pi allowed for pi state
            assert.ok(body.includes('.pi'), `profile should allow home/.pi:\n${body}`);
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
});
