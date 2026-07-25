/**
 * Unit: sandbox.ts profile matches the confinement contract used by subagents.
 * @covers sandbox.backend-selection
 * @covers sandbox.command-wrapper
 * @level unit
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { sandboxSupported, buildSandboxCommand } = await import(new URL('../sandbox.ts', import.meta.url).href);

describe('sandbox profile (subagent write confinement)', () => {
    // @characterizes sandbox.backend-selection
    // @covers sandbox.backend-selection
    // @level unit
    it('sandboxSupported is true only on darwin', () => {
        assert.equal(typeof sandboxSupported(), 'boolean');
        if (process.platform === 'darwin') assert.equal(sandboxSupported(), true);
        else assert.equal(sandboxSupported(), false);
    });

    // @characterizes sandbox.spawn-policy
    // @covers sandbox.spawn-policy
    // @level unit
    it('keeps the caller policy default-on, explicit-request, and explicit-opt-out shape', () => {
        const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
        assert.ok(source.includes('const explicitSandbox = p.sandbox === true || typeof p.sandbox_dir === "string";'));
        assert.ok(source.includes('let wantSandbox = p.sandbox !== false; // default on'));
        assert.ok(source.includes('if (wantSandbox && !sandboxSupported()) {'));
        assert.ok(source.includes('if (explicitSandbox) throw new Error("sandbox is only supported on macOS (sandbox-exec). Pass sandbox:false on this platform.");'));
        assert.ok(source.includes('wantSandbox = false;'));
    });

    // @characterizes sandbox.command-wrapper
    // @covers sandbox.command-wrapper
    // @level unit
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
                piArgs: ['-p', '--mode', 'json', 'original prompt'],
            });
            assert.equal(cmd.file, '/usr/bin/sandbox-exec');
            assert.deepEqual(
                cmd.fileArgs,
                ['-f', profilePath, '/usr/bin/true', '-p', '--mode', 'json', 'original prompt'],
                'wrapper must preserve the executable and original pi argv order',
            );

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
