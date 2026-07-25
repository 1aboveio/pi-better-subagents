/**
 * Unit: the backend-neutral sandbox-selection seam (issue #39 prefactor).
 *
 * One platform-neutral module boundary: the caller asks `sandboxSupported()`
 * and `buildSandboxCommand()`; the platform → backend mapping lives behind
 * `selectSandboxBackend()`. Selection is pure and side-effect free.
 *
 * // @covers sandbox.backend-selection
 * // @level unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Namespace import: the seam does not exist before the prefactor, and the RED
// state must be a clean assertion failure, not a module link error.
import * as sandbox from '../sandbox.ts';

describe('sandbox backend selection (platform-neutral seam, #39)', () => {
    // @covers sandbox.backend-selection
    // @level unit
    it('exposes selectSandboxBackend', () => {
        assert.equal(typeof sandbox.selectSandboxBackend, 'function');
    });

    // @covers sandbox.backend-selection
    // @level unit
    it('selects the sandbox-exec backend on darwin', () => {
        const backend = sandbox.selectSandboxBackend('darwin');
        assert.ok(backend, 'darwin must have a backend');
        assert.equal(backend.id, 'sandbox-exec');
        assert.equal(typeof backend.buildCommand, 'function');
    });

    // @covers sandbox.backend-selection
    // @level unit
    // @characterizes sandbox.support-query
    it('returns null for platforms with no registered backend (characterizes pre-#40 mapping)', () => {
        // Pre-#40 behavior: Linux has no backend yet (added in #40), Windows
        // stays unsupported. This is characterization of already-true
        // unsupported-platform behavior, not TDD RED.
        assert.equal(sandbox.selectSandboxBackend('linux'), null);
        assert.equal(sandbox.selectSandboxBackend('win32'), null);
    });

    // @covers sandbox.backend-selection
    // @level unit
    it('defaults to the host platform and drives the public support query', () => {
        assert.equal(sandbox.selectSandboxBackend() !== null, process.platform === 'darwin');
        assert.equal(sandbox.sandboxSupported(), sandbox.selectSandboxBackend() !== null);
    });

    // @covers sandbox.backend-selection
    // @level unit
    it('selection is side-effect free: a stable registry lookup, no construction per call', () => {
        assert.equal(sandbox.selectSandboxBackend('darwin'), sandbox.selectSandboxBackend('darwin'));
    });

    // @covers sandbox.command-wrapper
    // @level unit
    it('the public wrapper is built through the platform backend boundary', () => {
        const base = mkdtempSync(join(tmpdir(), 'pi-sbx-seam-'));
        const writable = join(base, 'work');
        const profilePath = join(base, 'profile.sb');
        mkdirSync(writable, { recursive: true });
        const args = {
            profilePath,
            writableDir: writable,
            home: join(base, 'home'),
            piBin: '/usr/bin/true',
            piArgs: ['-p'],
        };
        try {
            const cmd = sandbox.buildSandboxCommand(args);
            const selected = sandbox.selectSandboxBackend();
            if (process.platform === 'darwin') {
                assert.ok(selected, 'darwin must select a backend');
                assert.deepEqual(selected.buildCommand(args), cmd);
            } else {
                // Characterizes the pre-#40 fallback: no registered backend on
                // this host, and the historical sandbox-exec construction is
                // preserved unchanged (the wrapper builder never checked the
                // platform before the prefactor either).
                assert.equal(selected, null);
                assert.equal(cmd.file, '/usr/bin/sandbox-exec');
                assert.deepEqual(cmd.fileArgs, ['-f', profilePath, '/usr/bin/true', '-p']);
            }
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
});
