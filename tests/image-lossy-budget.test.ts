// Deliverability vs fidelity: a body whose bulk is screenshots can be refused
// for SIZE by an upstream (observed shape: 6 shots at 1264x805, 4.88MiB of PNG
// that only GROWS ~16% when re-encoded losslessly, a ~7.0MiB body, resets in
// 0.2-0.5s while every request under ~6MiB passed). The user explicitly chose
// lossy over "always fails": re-encode images on the SEND copy (never the
// stored original) so the turn goes through, and keep images PRESENT instead of
// archiving them away — the model still sees the picture, just softer.
//
// Rules this pins:
//   * a body under the budget is byte-identical (no gratuitous quality loss);
//   * above it, every image is still an image (count preserved, none archived);
//   * alpha images are never turned into JPEG (that would flatten transparency);
//   * the `acp_read_original_image` receipt lane is untouched (that lane exists
//     precisely so the model can ask for full fidelity);
//   * the knob turns the whole thing off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Jimp } from "jimp";

import { clearRescaleEncodeCache } from "../src/image-rescale.ts";
import { applyLossyImageBudget, clearLossyEncodeCache, resolveLossyBudget } from "../src/image-lossy.ts";

const MiB = 1024 * 1024;

/** A byte-heavy screenshot-like PNG (noise keeps PNG big, like a real UI shot). */
async function heavyPng(width = 1264, height = 805): Promise<{ b64: string; bytes: number }> {
    const img = new Jimp({ width, height });
    // Write the RGBA bitmap directly: setPixelColor() leaves stray alpha-0
    // pixels behind, and an opaque fixture is the whole point here.
    const data = img.bitmap.data;
    let seed = 12345;
    for (let i = 0; i < width * height; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[i * 4] = (seed >> 16) & 0xff;
        data[i * 4 + 1] = (seed >> 8) & 0xff;
        data[i * 4 + 2] = seed & 0xff;
        data[i * 4 + 3] = 255;
    }
    const buf = await img.getBuffer("image/png");
    return { b64: buf.toString("base64"), bytes: buf.length };
}

async function alphaPng(width = 640, height = 480): Promise<{ b64: string; bytes: number }> {
    const img = new Jimp({ width, height });
    const data = img.bitmap.data;
    for (let i = 0; i < width * height; i++) {
        const x = i % width;
        data[i * 4] = 0xff;
        data[i * 4 + 1] = 0x00;
        data[i * 4 + 2] = 0x00;
        data[i * 4 + 3] = x < width / 2 ? 0 : 255;
    }
    const buf = await img.getBuffer("image/png");
    return { b64: buf.toString("base64"), bytes: buf.length };
}

function openaiBody(images: string[]): string {
    const messages: unknown[] = [];
    images.forEach((url, i) => {
        messages.push({ role: "user", content: [{ type: "text", text: `shot ${i}` }, { type: "image_url", image_url: { url } }] });
        messages.push({ role: "assistant", content: `ok ${i}` });
    });
    for (let i = 0; i < 8; i++) messages.push({ role: "user", content: `tail ${i}` });
    return JSON.stringify({ model: "gpt-x", messages });
}

function imageUrls(body: string): string[] {
    const parsed = JSON.parse(body) as { messages: Array<{ content?: unknown }> };
    const out: string[] = [];
    for (const m of parsed.messages) {
        if (!Array.isArray(m.content)) continue;
        for (const part of m.content as Array<{ type?: string; image_url?: { url?: string } }>) {
            if (part.type === "image_url" && typeof part.image_url?.url === "string") out.push(part.image_url.url);
        }
    }
    return out;
}

test("lossy budget: a body under the budget is byte-identical (negative)", async () => {
    clearRescaleEncodeCache();
    clearLossyEncodeCache();
    const shot = await heavyPng(400, 300);
    const body = openaiBody([`data:image/png;base64,${shot.b64}`]);
    const out = await applyLossyImageBudget(body, "openai", 64 * MiB);
    assert.equal(out.body, body, "no re-encode below the budget");
    assert.equal(out.stats.changed, false);
});

test("lossy budget: over budget, images stay images and the body shrinks under the budget", async () => {
    clearRescaleEncodeCache();
    const shots: string[] = [];
    for (let i = 0; i < 3; i++) shots.push(`data:image/png;base64,${(await heavyPng()).b64}`);
    const body = openaiBody(shots);
    const budget = 2 * MiB;
    assert.ok(Buffer.byteLength(body) > budget, `fixture must exceed the budget, got ${Buffer.byteLength(body)}`);

    const out = await applyLossyImageBudget(body, "openai", budget);
    assert.equal(out.stats.changed, true);
    assert.ok(out.stats.finalBytes <= budget, `reached the budget: ${out.stats.finalBytes} <= ${budget}`);
    const urls = imageUrls(out.body);
    assert.equal(urls.length, 3, "every image is still an image part (none archived)");
    assert.ok(urls.every((u) => u.startsWith("data:image/jpeg;base64,")), "opaque screenshots become JPEG");
    assert.equal(out.stats.archived, 0, "nothing was dropped");
});

test("lossy budget: transparency is never flattened to JPEG (negative: alpha stays PNG)", async () => {
    clearRescaleEncodeCache();
    const shots: string[] = [];
    for (let i = 0; i < 4; i++) shots.push(`data:image/png;base64,${(await alphaPng()).b64}`);
    const body = openaiBody(shots);
    const out = await applyLossyImageBudget(body, "openai", 512 * 1024);
    const urls = imageUrls(out.body);
    assert.equal(urls.length, 4);
    assert.ok(urls.every((u) => u.startsWith("data:image/png;base64,")), "alpha images keep their PNG format");
});

test("lossy budget: the receipt lane is left alone (negative: read_original_image)", async () => {
    clearRescaleEncodeCache();
    const shot = await heavyPng();
    // An anthropic tool_result carrying the receipt must never be re-encoded:
    // that lane exists so the model can request full fidelity.
    const receipt = { type: "tool_result", tool_use_id: "t1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: shot.b64 } }] };
    const body = JSON.stringify({
        model: "claude-x",
        messages: [
            { role: "user", content: "look" },
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "acp_read_original_image", input: { ref: "m00001" } }] },
            { role: "user", content: [receipt] },
            ...Array.from({ length: 9 }, (_, i) => ({ role: "user", content: `tail ${i}` })),
        ],
    });
    const out = await applyLossyImageBudget(body, "anthropic", 256 * 1024);
    assert.equal(out.stats.changed, false, "the receipt image is exempt");
    assert.equal(out.body, body);
});

test("lossy budget: the per-image target is set-independent (appending a shot must not re-encode the earlier ones)", async () => {
    clearRescaleEncodeCache();
    clearLossyEncodeCache();
    const a = await heavyPng(900, 620);
    const b = await heavyPng(900, 620);
    const two = openaiBody([`data:image/png;base64,${a.b64}`, `data:image/png;base64,${b.b64}`]);
    const three = openaiBody([`data:image/png;base64,${a.b64}`, `data:image/png;base64,${b.b64}`, `data:image/png;base64,${b.b64}`]);
    // Budget under BOTH bodies but above the stable per-image target for three
    // images, so stage A alone decides the outcome in both runs.
    const budget = Math.floor(Buffer.byteLength(two) * 0.8);
    assert.ok(budget > 3 * 400 * 1024, `budget must leave stage A enough room (${budget})`);
    const first = await applyLossyImageBudget(two, "openai", budget);
    const second = await applyLossyImageBudget(three, "openai", budget);
    assert.equal(first.stats.changed, true, "the two-image body was over budget and got re-encoded");
    assert.equal(first.stats.tightened, false, "stage A alone was enough for two images");
    assert.equal(second.stats.tightened, false, "stage A alone was enough for three images");
    const one = imageUrls(first.body);
    const twoUrls = imageUrls(second.body);
    assert.equal(one.length, 2);
    assert.equal(twoUrls.length, 3);
    // The same screenshot must encode to the SAME bytes whether the turn carries
    // two images or three — otherwise every added shot breaks the upstream prefix
    // cache from the first image onward.
    assert.equal(one[0], twoUrls[0], "the first image is byte-identical after appending a shot");
    assert.equal(one[1], twoUrls[1], "the second image is byte-identical after appending a shot");
    assert.match(one[0], /^data:image\/jpeg;base64,/, "the pass really did re-encode (not a no-op pass)");
});

test("lossy budget: a tiny alpha image is never UPSCALED to the resolution floor (negative)", async () => {
    clearRescaleEncodeCache();
    clearLossyEncodeCache();
    const small = await alphaPng(200, 150);
    const body = JSON.stringify({
        model: "x",
        messages: [
            { role: "user", content: [{ type: "text", text: "tiny" }, { type: "image_url", image_url: { url: `data:image/png;base64,${small.b64}` } }] },
            ...Array.from({ length: 6 }, (_, i) => ({ role: "user", content: `tail ${i}` })),
        ],
    });
    // A budget the image already fits: nothing to do, and certainly no "downscale"
    // whose floor is larger than the image itself.
    const out = await applyLossyImageBudget(body, "openai", 4 * 1024 * 1024);
    assert.equal(out.stats.changed, false, "an 200x150 image under budget is left alone");
    assert.equal(out.body, body);
});

test("lossy budget: an unreachable budget reports the truth instead of claiming a fit", async () => {
    clearRescaleEncodeCache();
    clearLossyEncodeCache();
    const shot = await heavyPng(1000, 700);
    const body = openaiBody([`data:image/png;base64,${shot.b64}`]);
    const bytes = Buffer.byteLength(body);
    // A budget far below what a single image can ever reach: the pass must say so
    // (stillOverBudget) rather than log a phantom success.
    const out = await applyLossyImageBudget(body, "openai", 64 * 1024);
    assert.equal(out.stats.changed, true, "the image was still re-encoded as far as it can go");
    assert.ok(out.stats.transcoded <= 1, "one image counts once, not once per attempt");
    if (Buffer.byteLength(out.body) > 64 * 1024) {
        assert.equal(out.stats.stillOverBudget, true, "a body that is still too big says so");
    }
    assert.equal(out.stats.finalBytes, Buffer.byteLength(out.body), "finalBytes is the real serialized size");
});

test("lossy policy: the knob's default is 5 MiB, and 0 disables", () => {
    assert.equal(resolveLossyBudget(undefined), 5 * 1024 * 1024);
    assert.equal(resolveLossyBudget("0"), undefined);
    assert.equal(resolveLossyBudget(""), 5 * 1024 * 1024);
    assert.equal(resolveLossyBudget("2097152"), 2 * 1024 * 1024);
});
