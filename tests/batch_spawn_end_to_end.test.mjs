/**
 * End-to-end batch spawn test using a fake `pi` binary.
 *
 * This exercises the real index.ts spawn path without a model: a fake `pi`
 * executable is placed on PATH, the extension is loaded with a stubbed
 * ExtensionAPI, and subagent_spawn_batch is invoked. Each child writes a
 * minimal JSON log and exits 0, so registry/parse/finalize paths are real.
 *
 * // @covers subagent-spawn-batch.end-to-end
 * // @level integration
 */
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    chmodSync,
    rmSync,
    symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const RUNTIME = mkdtempSync(join(tmpdir(), "batch-spawn-e2e-"));
process.env.TMPDIR = RUNTIME;

// Stub packages are created in a temp stubs dir and symlinked into the repo's
// node_modules so ESM resolution finds them for index.ts.
const STUBS_DIR = mkdtempSync(join(RUNTIME, "stubs-"));
const NODE_MODULES = join(REPO_ROOT, "node_modules");

function ensureStub(name, files) {
    const pkgDir = join(STUBS_DIR, name);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name, type: "module", main: "index.js", exports: { ".": "./index.js" } }),
    );
    for (const [file, content] of Object.entries(files)) {
        writeFileSync(join(pkgDir, file), content);
    }

    const linkParent = join(NODE_MODULES, dirname(name));
    mkdirSync(linkParent, { recursive: true });
    const linkPath = join(NODE_MODULES, name);
    try { rmSync(linkPath, { recursive: true, force: true }); } catch {}
    symlinkSync(pkgDir, linkPath, "dir");
}

function clearRuns() {
    const runsDir = join(RUNTIME, "pi-better-subagents", "runs");
    rmSync(runsDir, { recursive: true, force: true });
}

function writeRunningMeta({ writeMeta, nextRunId }, name) {
    const id = nextRunId();
    const startedAt = Date.now();
    writeMeta({
        id,
        name,
        status: "running",
        pid: process.pid,
        spawnPid: process.pid,
        cwd: RUNTIME,
        promptPreview: "fake",
        startedAt,
        logPath: join(RUNTIME, "pi-better-subagents", "runs", id, "output.log"),
        sessionId: id,
    });
    return id;
}

function setupStubs() {
    mkdirSync(NODE_MODULES, { recursive: true });
    ensureStub("@earendil-works/pi-ai", {
        "index.js": `
const scalar = (type, opts = {}) => ({ type, ...opts });
export const Type = {
    String: (opts) => scalar("string", opts),
    Number: (opts) => scalar("number", opts),
    Boolean: (opts) => scalar("boolean", opts),
    Optional: (schema) => schema,
    Array: (schema, opts = {}) => ({ type: "array", items: schema, ...opts }),
    Object: (props, opts = {}) => ({ type: "object", properties: props, ...opts }),
};
`,
    });
    ensureStub("@earendil-works/pi-coding-agent", {
        "index.js": "// Type-only stub\nexport {}\n",
    });
}

function fakePiScript() {
    return `#!/bin/bash
id=""
sess=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-id) id="$2"; shift 2 ;;
    --session-dir) sess="$2"; shift 2 ;;
    *) shift ;;
  esac
done
base=$(dirname "$sess")
log="$base/runs/$id/output.log"
mkdir -p "$(dirname "$log")"
printf '%s\n' '{"type":"agent_settled"}' '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}' > "$log"
`;
}

function makeMockPi() {
    const binDir = mkdtempSync(join(RUNTIME, "fake-bin-"));
    const piPath = join(binDir, "pi");
    writeFileSync(piPath, fakePiScript(), { mode: 0o755 });
    chmodSync(piPath, 0o755);
    return binDir;
}

function makeCtx() {
    return {
        cwd: RUNTIME,
        model: { provider: "test", id: "model" },
        hasUI: false,
        ui: { setWidget() {}, notify() {} },
    };
}

function loadExtension(mod) {
    const tools = {};
    const messages = [];
    const pi = {
        registerTool(def) {
            tools[def.name] = def;
        },
        on() {},
        sendMessage(msg, opts) {
            messages.push({ msg, opts });
        },
    };
    mod.default(pi);
    return { tools, messages };
}

describe("subagent_spawn_batch end-to-end", () => {
    let origPath;
    let mod;
    let registry;

    before(async () => {
        origPath = process.env.PATH;
        setupStubs();
        const binDir = makeMockPi();
        process.env.PATH = `${binDir}:${origPath}`;
        mod = await import("../index.ts");
        registry = await import("../registry.ts");
    });

    beforeEach(() => {
        clearRuns();
    });

    after(() => {
        process.env.PATH = origPath;
        rmSync(RUNTIME, { recursive: true, force: true });
        try { rmSync(NODE_MODULES, { recursive: true, force: true }); } catch {}
    });

    it("launches multiple jobs and records batchId/batchName in each meta", async () => {
        const { tools } = loadExtension(mod);
        const ctx = makeCtx();

        const res = await tools.subagent_spawn_batch.execute(
            "tc1",
            {
                batchName: "reviewers",
                shared: { model: "test/model", tools: "read,bash" },
                jobs: [
                    { prompt: "say hello" },
                    { prompt: "say world" },
                ],
            },
            null,
            null,
            ctx,
        );

        const text = res.content[0].text;
        assert.match(text, /Batch reviewers \(batch_[a-z0-9_]+\) launched 2 Subagent\(s\):/i);
        const ids = [...text.matchAll(/→ (sa_[a-z0-9_]+)/g)].map((m) => m[1]);
        assert.equal(ids.length, 2);
        assert.notEqual(ids[0], ids[1]);

        for (const id of ids) {
            const meta = registry.readMeta(id);
            assert.ok(meta, `meta for ${id} should exist`);
            assert.ok(meta.batchId, `meta.batchId should be set for ${id}`);
            assert.equal(meta.batchName, "reviewers");
            assert.equal(meta.status, "running");
            assert.equal(meta.model, "test/model");
        }
    });

    it("rejects the whole batch before launching when capacity is exceeded", async () => {
        const { tools } = loadExtension(mod);
        const ctx = makeCtx();

        // Fill capacity by writing four running metas for this parent PID.
        for (let i = 0; i < 4; i++) {
            writeRunningMeta(registry, `runner-${i}`);
        }

        await assert.rejects(
            () =>
                tools.subagent_spawn_batch.execute(
                    "tc2",
                    { shared: { tools: "read,bash" }, jobs: [{ prompt: "overflow" }] },
                    null,
                    null,
                    ctx,
                ),
            /Batch of 1 jobs exceeds available capacity \(0\/4 subagent slots free\)/,
        );
    });

    it("launch-available partial launch reports skipped jobs", async () => {
        const { tools } = loadExtension(mod);
        const ctx = makeCtx();

        // Fill capacity to 3/4.
        for (let i = 0; i < 3; i++) {
            writeRunningMeta(registry, `runner-${i}`);
        }

        const res = await tools.subagent_spawn_batch.execute(
            "tc3",
            {
                shared: { tools: "read,bash" },
                jobs: [{ prompt: "a" }, { prompt: "b" }],
                onCapacity: "launch-available",
            },
            null,
            null,
            ctx,
        );

        const text = res.content[0].text;
        assert.match(text, /launched 1 subagent\(s\):/i);
        assert.match(text, /Skipped \(capacity\): job-2/);
    });

    it("single subagent_spawn still works and leaves batch fields empty", async () => {
        const { tools } = loadExtension(mod);
        const ctx = makeCtx();

        const res = await tools.subagent_spawn.execute("tc", { prompt: "solo", tools: "read,bash" }, null, null, ctx);
        const text = res.content[0].text;
        const match = text.match(/id=(sa_[a-z0-9_]+)/);
        assert.ok(match);
        const meta = registry.readMeta(match[1]);
        assert.equal(meta.batchId, undefined);
        assert.equal(meta.batchName, undefined);
    });
});
