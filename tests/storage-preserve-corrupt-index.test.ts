import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UnifiedStore } from "../src/storage/store.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";

test("corrupt index is retained instead of being replaced", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-preserve-index-"));
    try {
        const file = join(dir, "index.db");
        UnifiedStore.open(file).close();
        const bytes = readFileSync(file);
        for (let i = Math.floor(bytes.length / 3); i < Math.floor(bytes.length / 3) + 4096; i++) bytes[i] ^= 0xff;
        writeFileSync(file, bytes);
        const shadow = UnifiedShadow.maybeOpen(dir, { ...process.env, BILI_STORAGE_UNIFIED: "full" });
        if (shadow) shadow.close();
        assert.equal(shadow, null, "corrupt index must not be replaced with a fresh store");
        assert.deepEqual(readFileSync(file), bytes, "original index bytes must be preserved");
        assert.ok(!readdirSync(dir).some((name) => name.includes(".corrupt-")), "no files are moved away");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
