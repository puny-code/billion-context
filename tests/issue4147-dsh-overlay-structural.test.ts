import test from "node:test";
import assert from "node:assert/strict";
import {
    _resetDshCompactionGateTelemetryForTest,
    _resetDshCompactionVerdictForTest,
    declareDshCompactionActive,
    declareDshCompactionInactive,
    dshCompactionGateTelemetry,
    registerCompactionDisable,
} from "../src/agent/dsh-compaction-disable.ts";

// #4147/#3962: historical structural matches must now remain host-owned;
// neither nested native rows nor entry names authorize disabling/replacement.
type Mw = (raw: unknown, next: () => unknown) => unknown;

function middleware(): Mw {
    let mw: Mw | undefined;
    registerCompactionDisable({
        on: (_event, listener) => { mw = listener as Mw; },
        reflect: {},
    });
    assert.equal(typeof mw, "function");
    return mw as Mw;
}

for (const verdict of ["absent", "active", "inactive"] as const) {
    test(`#4147: ${verdict} verdict preserves nested native rows and backend identity`, () => {
        try {
            _resetDshCompactionVerdictForTest();
            _resetDshCompactionGateTelemetryForTest();
            if (verdict === "active") declareDshCompactionActive();
            if (verdict === "inactive") declareDshCompactionInactive();
            const mw = middleware();
            const backend = Object.freeze({ name: "host-basic-backend" });
            const basic = Object.freeze({ name: "@deepseek-ai/dsh-compaction-basic", config: Object.freeze({ auto: true, backend }) });
            const command = Object.freeze({ name: "@deepseek-ai/dsh-command-compact" });
            const preDisabled = Object.freeze({ name: "@deepseek-ai/dsh-compaction-basic", disabled: true });
            const group = Object.freeze({ group: true, config: Object.freeze([basic, preDisabled]) });
            const plugins = Object.freeze([Object.freeze({ name: "@deepseek-ai/dsh-other" }), group, command]);
            const cfg = Object.freeze({ plugins });
            for (const entry of ["preset-general", "@deepseek-ai/dsh-agent-preset", "file:///".padEnd(200, "x"), undefined]) {
                let calls = 0;
                const self = entry === undefined ? undefined : { entry: { options: { name: entry } } };
                const out = mw.call(self, { plugins: [] }, () => { calls++; return cfg; });
                assert.equal(calls, 1, "resolved config is requested exactly once");
                assert.equal(out, cfg, "resolved object passes through without cloning");
                assert.equal(cfg.plugins, plugins);
                assert.equal(plugins[1], group);
                assert.equal(group.config[0], basic);
                assert.equal(basic.config.backend, backend, "native backend is never replaced");
                assert.equal(Object.hasOwn(basic, "disabled"), false, "Basic stays enabled");
                assert.equal(Object.hasOwn(command, "disabled"), false, "manual compact stays enabled");
                assert.equal(preDisabled.disabled, true, "host-authored disabled state is not cleared");
                assert.equal(dshCompactionGateTelemetry(), null, "no native rewrite coverage may be claimed");
            }
        } finally {
            _resetDshCompactionVerdictForTest();
            _resetDshCompactionGateTelemetryForTest();
        }
    });
}

test("#4147 negative: unrelated, missing-plugin and non-object configs pass through unchanged", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        declareDshCompactionActive();
        const mw = middleware();
        for (const cfg of [
            Object.freeze({ plugins: Object.freeze([Object.freeze({ name: "@deepseek-ai/dsh-tool-result-pruner" })]) }),
            Object.freeze({ other: 1 }),
            null,
            undefined,
            "host-config",
        ]) {
            assert.equal(mw.call({ entry: { options: { name: "preset-shipin" } } }, null, () => cfg), cfg);
        }
        assert.equal(dshCompactionGateTelemetry(), null, "unrelated configs produce no rewrite telemetry");
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});
