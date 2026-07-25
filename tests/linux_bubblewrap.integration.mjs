/**
 * Linux integration: the product command builder and detached spawner execute
 * a real bubblewrap child with the production mount topology.
 * @covers sandbox.command-wrapper
 * @covers sandbox.spawn-policy
 * @level integration
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const { maybeBuildSandboxCommand, sandboxSupported } = await import(
    new URL('../sandbox.ts', import.meta.url).href,
);
const { spawnDetached } = await import(new URL('../spawn.ts', import.meta.url).href);

it('launches a real Linux child through bubblewrap with confined writes', async () => {
    assert.equal(process.platform, 'linux', 'this Linux CI test must not run on another platform');
    assert.equal(sandboxSupported(), true, 'Linux CI must install executable bubblewrap before this test runs');

    const base = mkdtempSync(join(process.cwd(), '.pi-bwrap-integration-'));
    const workdir = join(base, 'work');
    const outsidePath = join(base, 'outside.txt');
    const tmpPath = join(tmpdir(), `pi-bwrap-tmp-${process.pid}-${Date.now()}`);
    mkdirSync(workdir, { recursive: true });

    try {
        const command = maybeBuildSandboxCommand({
            profilePath: join(base, 'unused.sb'),
            writableDir: workdir,
            home: homedir(),
            piBin: '/bin/sh',
            piArgs: [
                '-eu', '-c',
                'printf inside > "$1/inside.txt"\n' +
                'printf temp > "$2"\n' +
                ': > /dev/null\n' +
                'if printf outside > "$3"; then exit 86; fi\n' +
                'test "$(cat "$1/inside.txt")" = inside\n' +
                'test "$(cat "$2")" = temp\n' +
                'rm "$2"',
                'sh', workdir, tmpPath, outsidePath,
            ],
        }, { sandboxEnabled: true, explicitSandbox: true });
        assert.ok(command, 'an available Linux backend must produce a wrapper command');

        const spawned = spawnDetached({
            file: command.file,
            fileArgs: command.fileArgs,
            cwd: workdir,
            logPath: join(base, 'child.log'),
        });
        // spawnDetached intentionally unrefs children; retain this test process
        // only until the real bwrap child closes.
        const keepAlive = setInterval(() => {}, 1000);
        try {
            assert.equal(await spawned.exit, 0, readFileSync(join(base, 'child.log'), 'utf8'));
        } finally {
            clearInterval(keepAlive);
        }

        assert.equal(readFileSync(join(workdir, 'inside.txt'), 'utf8'), 'inside');
        assert.equal(existsSync(outsidePath), false, 'host root must stay read-only outside the selected workdir');
        assert.equal(existsSync(tmpPath), false, 'host /tmp must be writable for the child and removable afterward');
    } finally {
        rmSync(tmpPath, { force: true });
        rmSync(base, { recursive: true, force: true });
    }
});
