import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeDshClientShimFiles } from "../src/launcher.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("launcher shim keeps the compatibility gate without exporting a replacement native backend", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-gate-shim-"));
    try {
        const bundles = ["host", "client", "gate"].map((name) => {
            const file = path.join(root, `${name}.js`);
            fs.writeFileSync(file, "export const fixture=true;");
            return file;
        });
        const shim = path.join(root, "shim");
        assert.equal(writeDshClientShimFiles(shim, bundles[0], bundles[1], "test", bundles[2]), true);
        const config = JSON.parse(fs.readFileSync(path.join(shim, "package.json"), "utf8")) as { exports: Record<string, string> };
        assert.equal(config.exports["./dsh-compaction-gate"], "./gate.js");
        assert.equal(fs.realpathSync(path.join(shim, "gate.js")), fs.realpathSync(bundles[2]));
        assert.equal(config.exports["./dsh-compaction-backend"], undefined);
        assert.equal(fs.existsSync(path.join(shim, "compaction-backend.js")), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("published package retains the gate but does not publish the abandoned backend entry", () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { exports: Record<string, string> };
    assert.equal(config.exports["./dsh-compaction-gate"], "./dist/agent/dsh-compaction-gate.js");
    assert.equal(config.exports["./dsh-compaction-backend"], undefined);
    const build = fs.readFileSync(path.join(ROOT, "tsup.config.ts"), "utf8");
    assert.equal(build.includes('"src/agent/dsh-compaction-gate.ts"'), true);
    assert.equal(build.includes('"src/agent/dsh-compaction-backend.ts"'), false);
});
