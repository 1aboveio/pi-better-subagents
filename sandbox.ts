/**
 * OS-level write sandbox for subagent children (macOS `sandbox-exec`).
 *
 * Kernel-enforced confinement: the child may READ anywhere and use the network
 * (so web_fetch and the model API keep working), but may only WRITE under a
 * single directory plus the system paths pi itself needs to function. Unlike the
 * cooperative guardrails layer (which pattern-matches tool inputs), this cannot
 * be evaded by a crafted bash command — the write syscall itself is denied.
 *
 * macOS only. `sandbox-exec` is deprecated by Apple but present and functional
 * on current macOS; on other platforms callers must not request a sandbox.
 */

import { platform } from "node:os";
import { realpathSync, writeFileSync } from "node:fs";

/** True when an OS write-sandbox can be applied on this platform. */
export function sandboxSupported(): boolean {
    return platform() === "darwin";
}

/** Quote a path as an SBPL string literal. */
function sbpl(path: string): string {
    return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Write a sandbox-exec profile confining writes to `writableDir` (+ the system
 * paths pi needs) to `profilePath`. Returns the argv to exec the sandbox, given
 * the pi binary and its args: `[sandbox-exec, -f, profile, pi, ...args]`.
 */
export function buildSandboxCommand(args: {
    profilePath: string;
    writableDir: string;
    home: string;
    piBin: string;
    piArgs: string[];
}): { file: string; fileArgs: string[] } {
    // Match on the real (symlink-resolved) path — sandbox-exec evaluates the
    // canonical path, so /tmp/x must be written as /private/tmp/x.
    let dir = args.writableDir;
    try { dir = realpathSync(dir); } catch { /* not yet created; use as given */ }

    const profile = [
        "(version 1)",
        "(allow default)",          // permissive base: reads, exec, network
        "(deny file-write*)",       // ...then deny all writes...
        `(allow file-write* (subpath ${sbpl(dir)}))`,               // ...except here
        `(allow file-write* (subpath ${sbpl(`${args.home}/.pi`)}))`, // pi state
        '(allow file-write* (subpath "/private/var/folders"))',      // macOS temp / our runtime
        '(allow file-write* (subpath "/private/tmp"))',
        '(allow file-write* (subpath "/dev"))',                      // /dev/null etc.
        "",
    ].join("\n");
    writeFileSync(args.profilePath, profile);

    return {
        file: "/usr/bin/sandbox-exec",
        fileArgs: ["-f", args.profilePath, args.piBin, ...args.piArgs],
    };
}
