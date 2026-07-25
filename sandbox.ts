/**
 * OS-level write sandbox for subagent children.
 *
 * Kernel-enforced confinement: the child may READ anywhere and use the network
 * (so web_fetch and the model API keep working), but may only WRITE under a
 * single directory plus the system paths pi itself needs to function. Unlike the
 * cooperative guardrails layer (which pattern-matches tool inputs), this cannot
 * be evaded by a crafted bash command — the write syscall itself is denied.
 *
 * Backend selection lives behind one platform-neutral boundary (#39): the
 * caller asks `sandboxSupported()` and receives one executable-plus-arguments
 * wrapper from `buildSandboxCommand()`, with no platform branches of its own.
 * macOS uses `sandbox-exec` (deprecated by Apple but present and functional on
 * current macOS). Linux gains a bubblewrap backend on this same seam in #40;
 * platforms with no registered backend report unsupported and keep the
 * existing degrade-vs-throw caller policy.
 */

import { platform as osPlatform } from "node:os";
import { realpathSync, writeFileSync } from "node:fs";

/** Arguments every backend needs to wrap the pi invocation. */
export interface SandboxCommandArgs {
    profilePath: string;
    writableDir: string;
    home: string;
    piBin: string;
    piArgs: string[];
}

/**
 * A platform write-sandbox backend: builds the one executable-plus-ordered-
 * arguments wrapper around the pi argv. Backend objects are constructed once
 * in the registry below; selection itself is a pure lookup — it spawns no
 * processes and probes nothing.
 */
export interface SandboxBackend {
    /** Stable backend identifier (for logs and error messages). */
    id: string;
    /** Build the wrapper command, ending in the unmodified pi argv. */
    buildCommand(args: SandboxCommandArgs): { file: string; fileArgs: string[] };
}

/** Quote a path as an SBPL string literal. */
function sbpl(path: string): string {
    return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The macOS `sandbox-exec` backend. Writes an SBPL profile confining writes to
 * `writableDir` (+ the system paths pi needs) to `profilePath`, and returns
 * the argv to exec the sandbox: `[sandbox-exec, -f, profile, pi, ...args]`.
 */
const sandboxExecBackend: SandboxBackend = {
    id: "sandbox-exec",
    buildCommand(args) {
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
    },
};

/**
 * Platform → backend registry. Only darwin has a backend today; #40 adds the
 * Linux bubblewrap backend here, and Windows remains unsupported.
 */
const BACKENDS: Readonly<Partial<Record<NodeJS.Platform, SandboxBackend>>> = {
    darwin: sandboxExecBackend,
};

/**
 * Select the write-sandbox backend for `platform` (default: the host platform).
 * Pure and side-effect free: a registry lookup, never a probe. Returns null
 * when the platform has no registered backend — exactly the "unsupported"
 * state the caller's degrade-vs-throw policy keys off.
 */
export function selectSandboxBackend(platform: NodeJS.Platform = osPlatform()): SandboxBackend | null {
    return BACKENDS[platform] ?? null;
}

/** True when an OS write-sandbox can be applied on this platform. */
export function sandboxSupported(): boolean {
    return selectSandboxBackend() !== null;
}

/**
 * Write the sandbox profile and return the wrapper argv, dispatched through
 * the selected platform backend.
 *
 * Until a second backend exists (#40), a platform with no registered backend
 * falls back to the historical sandbox-exec construction: the pre-#39 wrapper
 * builder never checked the platform, and existing callers/tests on any host
 * observe that behavior. Callers are still expected to gate on
 * `sandboxSupported()` first, as the spawn caller does.
 */
export function buildSandboxCommand(args: SandboxCommandArgs): { file: string; fileArgs: string[] } {
    const backend = selectSandboxBackend() ?? sandboxExecBackend;
    return backend.buildCommand(args);
}
