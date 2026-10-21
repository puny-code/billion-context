import test from "node:test";
import assert from "node:assert/strict";
import { OVERFLOW_REFOLD_MIN_SHRINK_PCT, refoldShrank, wireBodyBytes } from "../src/server/budget.ts";

// overflow-refold-noop: a refold that does not materially shrink the outbound body must not be
// re-sent. The incident shape: a 4.0 MiB body came back at the same size after
// the overflow refold (fold-reconcile re-anchored ids without folding anything)
// and was re-sent verbatim, billed twice and rejected 400 both times.

test("wireBodyBytes measures UTF-8 bytes for both body representations", () => {
    const text = '{"messages":[{"role":"user","content":"上下文溢出 ✓"}]}';
    assert.equal(wireBodyBytes(text), Buffer.byteLength(text, "utf8"));
    assert.equal(wireBodyBytes(Buffer.from(text, "utf8")), Buffer.byteLength(text, "utf8"));
});

test("refoldShrank accepts a material fold", () => {
    assert.equal(refoldShrank(1_000_000, 500_000), true);
    assert.equal(refoldShrank(1_000_000, 980_000), true);
});

test("refoldShrank rejects the no-shrink shapes", () => {
    // unchanged, larger, and the fold-reconcile re-anchor jitter (a few hundred
    // bytes on a multi-MiB body) — all "nothing folded".
    assert.equal(refoldShrank(1_000_000, 1_000_000), false);
    assert.equal(refoldShrank(1_000_000, 1_000_400), false);
    assert.equal(refoldShrank(1_000_000, 999_000), false);
    assert.equal(refoldShrank(4_194_304, 4_193_900), false);
    assert.equal(refoldShrank(0, 0), false);
});

test("the threshold is the documented 2% boundary, not a fuzzy margin", () => {
    assert.equal(OVERFLOW_REFOLD_MIN_SHRINK_PCT, 0.02);
    assert.equal(refoldShrank(1_000_000, 980_001), false);
});
