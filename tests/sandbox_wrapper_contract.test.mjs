/**
 * Characterization: the public sandbox command-wrapper contract that the
 * spawn caller (index.ts) relies on — pinned BEFORE the #39 backend-selection
 * prefactor so the refactor cannot silently shift it.
 *
 *   - one executable plus an ordered argument array
 *   - the array ends in the original pi executable and unmodified pi args,
 *     order preserved (detached spawn passes argv through with no shell)
 *   - the SBPL profile bytes are the exact confinement contract
 *
 * // @covers sandbox.command-wrapper
 * // @level unit
 * // @characterizes sandbox.command-wrapper
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxCommand, sandboxSupported } from '../sandbox.ts';

describe('sandbox command-wrapper contract (characterization for #39)', () => {
    // @covers sandbox.command-wrapper
    // @level unit
    // @characterizes sandbox.command-wrapper
    it('returns one executable plus ordered args ending in the unmodified pi argv', () => {
        const base = mkdtempSync(join(tmpdir(), 'pi-sbx-contract-'));
        const writable = join(base, 'work');
        const profilePath = join(base, 'profile.sb');
        mkdirSync(writable, { recursive: true });
        try {
            // Argument order and element identity must survive: detached spawn
            // execs argv with no shell, so spaces/quotes stay single elements.
            const piBin = '/usr/local/bin/pi';
            const piArgs = ['-p', '--mode', 'json', '--session-id', 'sa_contract', 'prompt with spaces, "quotes" & symbols'];
            const cmd = buildSandboxCommand({
                profilePath,
                writableDir: writable,
                home: join(base, 'home'),
                piBin,
                piArgs,
            });
            assert.equal(typeof cmd.file, 'string');
            assert.ok(Array.isArray(cmd.fileArgs));
            assert.equal(cmd.file, '/usr/bin/sandbox-exec');
            assert.deepEqual(cmd.fileArgs, ['-f', profilePath, piBin, ...piArgs]);
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers sandbox-profile
    // @level unit
    // @characterizes sandbox-profile
    it('writes the exact SBPL confinement profile (byte-pinned)', () => {
        const base = mkdtempSync(join(tmpdir(), 'pi-sbx-contract-'));
        const writable = join(base, 'work');
        const home = join(base, 'home');
        const profilePath = join(base, 'profile.sb');
        mkdirSync(writable, { recursive: true });
        try {
            buildSandboxCommand({
                profilePath,
                writableDir: writable,
                home,
                piBin: '/usr/bin/true',
                piArgs: ['-p'],
            });
            const resolved = realpathSync(writable);
            const expected = [
                '(version 1)',
                '(allow default)',
                '(deny file-write*)',
                `(allow file-write* (subpath "${resolved}"))`,
                `(allow file-write* (subpath "${home}/.pi"))`,
                '(allow file-write* (subpath "/private/var/folders"))',
                '(allow file-write* (subpath "/private/tmp"))',
                '(allow file-write* (subpath "/dev"))',
                '',
            ].join('\n');
            assert.equal(readFileSync(profilePath, 'utf8'), expected);
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers sandbox.support-query
    // @level unit
    // @characterizes sandbox.support-query
    it('support query is true exactly on darwin (pre-#40 platform mapping)', () => {
        assert.equal(typeof sandboxSupported(), 'boolean');
        assert.equal(sandboxSupported(), process.platform === 'darwin');
    });
});
