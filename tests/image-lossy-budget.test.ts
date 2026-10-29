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
import { applyLossyImageBudget, imageShedPolicy } from "../src/image-lossy.ts";

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

test("lossy policy: the knob's default is 5 MiB, and 0 disables", () => {
    assert.equal(imageShedPolicy({ env: undefined, config: undefined }).budgetBytes, 5 * 1024 * 1024);
    assert.equal(imageShedPolicy({ env: "0", config: undefined }).budgetBytes, undefined);
    assert.equal(imageShedPolicy({ env: undefined, config: 0 }).budgetBytes, undefined);
    assert.equal(imageShedPolicy({ env: "2097152", config: undefined }).budgetBytes, 2 * 1024 * 1024);
    assert.equal(imageShedPolicy({ env: undefined, config: 3 * 1024 * 1024 }).budgetBytes, 3 * 1024 * 1024);
});
