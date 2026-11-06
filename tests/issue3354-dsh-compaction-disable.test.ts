import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BILI_COMPACTION_DISABLE_SERVICE, compactionDisablePatchRows, declareDshCompactionActive, declareDshCompactionInactive, isDshCompactionActive, detectCompactionOverlayGap, disableBasicCompaction, registerCompactionDisable, dshCompactionGateTelemetry, _resetDshCompactionGateTelemetryForTest, _resetDshCompactionVerdictForTest } from "../src/agent/dsh-compaction-disable.ts";
import { writeDshAcpPatch } from "../src/launcher.ts";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PRESET_ROWS = compactionDisablePatchRows();
const GATE_INSERT = `- insert:\n    - id: bili-native\n      name: billion-context\n    - id: bili-compaction-gate\n      name: billion-context/dsh-compaction-gate\n`;

function nativeRows(): unknown[] {
    return [
        { name: "@deepseek-ai/dsh-compaction-basic", config: { auto: true } },
        { name: "@deepseek-ai/dsh-command-compact", disabled: false },
        { name: "@deepseek-ai/dsh-other" },
        { group: true, config: [
            { name: "@deepseek-ai/dsh-compaction-basic", config: { auto: false } },
            { name: "@deepseek-ai/dsh-command-compact", disabled: true },
            { group: true, config: [{ name: "@deepseek-ai/dsh-compaction-basic" }] },
        ] },
        null, 42, "s",
    ];
}

test("legacy disableBasicCompaction export leaves native Basic and manual rows unchanged", () => {
    const rows = nativeRows();
    const snapshot = JSON.stringify(rows);
    assert.deepEqual(disableBasicCompaction(rows), rows);
    assert.equal(JSON.stringify(rows), snapshot);
    assert.deepEqual(disableBasicCompaction([]), []);
});

test("gate provides the existing preset dependency even without the config hook", () => {
    registerCompactionDisable({});
    const provided: string[] = [];
    registerCompactionDisable({ reflect: { provide: (name) => provided.push(name) } });
    assert.deepEqual(provided, [BILI_COMPACTION_DISABLE_SERVICE]);
});

test("legacy capability diagnostics remain compatible", () => {
    assert.equal(detectCompactionOverlayGap({ on: () => {}, reflect: { provide: () => {} } }), null);
    assert.equal(detectCompactionOverlayGap({ reflect: { provide: () => {} } }), "no-config-hook");
    assert.equal(detectCompactionOverlayGap({}), "no-config-hook");
    assert.equal(detectCompactionOverlayGap({ on: () => {} }), "no-service-provide");
});

for (const verdict of ["absent", "active", "inactive"] as const) {
    test(`gate preserves native config identity and all rows when bili is ${verdict}`, () => {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        if (verdict === "active") declareDshCompactionActive();
        if (verdict === "inactive") declareDshCompactionInactive();
        let middleware: ((raw: unknown, next: () => unknown) => unknown) | undefined;
        const order: string[] = [];
        registerCompactionDisable({
            on: (event, listener, options) => {
                assert.equal(event, "internal/config");
                assert.deepEqual(options, { global: true });
                middleware = listener;
                order.push("middleware");
            },
            reflect: { provide: (name) => { assert.equal(name, BILI_COMPACTION_DISABLE_SERVICE); order.push("service"); } },
        });
        try {
            assert.deepEqual(order, ["middleware", "service"]);
            assert.equal(isDshCompactionActive(), verdict === "active");
            for (const entryName of ["@deepseek-ai/dsh-agent-preset", "preset-general", "other-entry"]) {
                const cfg = { plugins: nativeRows(), isolate: { compaction: true } };
                const before = JSON.stringify(cfg);
                let nextCalls = 0;
                const out = middleware!.call({ entry: { options: { name: entryName } } }, null, () => { nextCalls++; return cfg; });
                assert.equal(out, cfg, "bili must not replace a retained native preset generation");
                assert.equal(nextCalls, 1);
                assert.equal(JSON.stringify(cfg), before);
            }
            assert.equal(middleware!(null, () => undefined), undefined);
            assert.equal(dshCompactionGateTelemetry(), null, "pass-through must not claim rows were disabled");
        } finally {
            _resetDshCompactionVerdictForTest();
            _resetDshCompactionGateTelemetryForTest();
        }
    });
}

test("bundle and launcher patches keep preset gates without replacing or disabling native compaction", () => {
    const bundle = fs.readFileSync(path.join(TESTS_DIR, "..", "dsh.bundle.patch.yml"), "utf8").replaceAll("\r\n", "\n");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-cd-patch-"));
    try {
        const file = writeDshAcpPatch(home, "billion-context");
        assert.ok(file);
        const overlay = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
        for (const patch of [bundle, overlay]) {
            assert.ok(patch.includes(PRESET_ROWS));
            assert.ok(patch.includes(GATE_INSERT));
            assert.doesNotMatch(patch, /^- id: (?:compaction-basic|command-compact)\s*$/m);
            assert.equal(patch.includes("dsh-compaction-backend"), false);
            assert.equal(patch.includes("auto: false"), false);
            assert.match(patch, /retryableCodes: \[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE\]/);
        }
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(`${home}-bili`, { recursive: true, force: true });
    }
});
