/**
 * OS-level write sandbox for subagent children.
 *
 * Kernel-enforced confinement: the child may READ anywhere and use the network
 * (so web_fetch and the model API keep working), but may only WRITE under a
 * single directory plus the system paths pi itself needs to function. Unlike the
 * cooperative guardrails layer (which pattern-matches tool inputs), this cannot
 * be evaded by a crafted bash command — the write syscall itself is denied.
 *
 * Backends are selected here so callers retain a platform-neutral support query
 * and command-wrapper contract. Linux support adds a backend without changing
 * the detached spawning policy in the extension.
 */

import { platform } from "node:os";
import { realpathSync, writeFileSync } from "node:fs";

type SandboxCommandArgs = {
    profilePath: string;
    writableDir: string;
    home: string;
    piBin: string;
    piArgs: string[];
};

type SandboxCommand = { file: string; fileArgs: string[] };

type SandboxBackend = {
    buildCommand(args: SandboxCommandArgs): SandboxCommand;
};

/** Quote a path as an SBPL string literal. */
function sbpl(path: string): string {
    return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Build the existing macOS sandbox-exec wrapper and SBPL profile. */
function buildMacOSSandboxCommand(args: SandboxCommandArgs): SandboxCommand {
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

const macOSSandboxBackend: SandboxBackend = {
    buildCommand: buildMacOSSandboxCommand,
};

function selectedSandboxBackend(): SandboxBackend | undefined {
    if (platform() === "darwin") return macOSSandboxBackend;
    return undefined;
}

/** True when an OS write-sandbox backend can be applied on this platform. */
export function sandboxSupported(): boolean {
    return selectedSandboxBackend() !== undefined;
}

/**
 * Return the selected backend's executable and ordered argv wrapper around pi.
 * Callers first use sandboxSupported() to preserve the unsupported-platform
 * default-degrade and explicit-request policy. The fallback preserves the
 * pre-existing direct-call result for callers that do not perform that check.
 */
export function buildSandboxCommand(args: SandboxCommandArgs): SandboxCommand {
    return (selectedSandboxBackend() ?? macOSSandboxBackend).buildCommand(args);
}
