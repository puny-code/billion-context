/** Lossy image budget: keep the pictures, drop the bytes.
 *
 *  A turn whose bulk is screenshots can be refused by an upstream for SIZE. The
 *  measured case: six shots at 1264x805 (inside the 1600px rescale gate, so the
 *  normal pass correctly leaves them alone) = 4.88MiB of PNG, ~7.0MiB of body,
 *  reset 0.2-0.5s in, while every request under ~6MiB on the same host passed.
 *  Lossless re-encoding makes those PNGs ~16% BIGGER; JPEG q88 makes them ~73%
 *  smaller. So the only lever that keeps the turn deliverable is lossy — an
 *  explicit owner decision, not a default we take silently.
 *
 *  Invariants (pinned in tests/image-lossy-budget.test.ts):
 *   - under the budget: the body is returned untouched, byte for byte;
 *   - over it: images stay PRESENT (never archived) — the model keeps the
 *     picture, just softer, which beats "no image at all";
 *   - an image with real transparency is never JPEG'd (that would flatten
 *     alpha); it is downscaled as PNG instead;
 *   - the `acp_read_original_image` receipt lane is exempt (collectOccurrences
 *     enforces it) — that lane exists to fetch full fidelity on demand;
 *   - the ORIGINAL image is never touched: only this wire copy changes;
 *   - the per-image target is SET-INDEPENDENT: appending one more screenshot
 *     must not re-encode the earlier ones, or every added image would break the
 *     upstream prefix cache from the first image onward (#3266's 75%→28% class);
 *   - nothing here throws: a decoder/encoder failure degrades to "send the body
 *     unchanged", because a size-rejected turn must never become a 5xx.
 */
import { createHash } from "node:crypto";

import { collectOccurrences, type Occurrence } from "./egress-shed.js";
import { log as loggerLog } from "./logger.js";
import type { WireProtocol } from "./util.js";

/** Default trigger: the measured pass/fail cliff was ">= 6MiB: 29/44 failed;
 *  4-6MiB: 0/28" — start below the cliff, not at it. */
export const IMAGE_LOSSY_DEFAULT_BYTES = 5 * 1024 * 1024;
/** Stable per-image ceiling (base64 chars) for the first stage. Fixed per image,
 *  NOT derived from the image count, so the same screenshot encodes identically
 *  whether the turn carries two images or six — that keeps the prefix cache. */
export const IMAGE_LOSSY_PER_IMAGE_CHARS = 400 * 1024;
/** JPEG quality ladder, best first — stop at the first rung that fits. */
const JPEG_QUALITY_LADDER = [88, 80, 72, 64, 56];
/** Resolution floor: below this a screenshot stops being readable, so stop. */
const MIN_LOSSY_DIM = 320;
/** Per-image floor for the tightening stage. */
const MIN_PER_IMAGE_BYTES = 120 * 1024;
/** Above this an image is a decompression bomb, not a screenshot: skip it rather
 *  than allocate hundreds of MiB of RGBA inside the proxy. */
const MAX_DECODE_CHARS = 12 * 1024 * 1024;
/** Bounded work per request — the point is to rescue a turn, not to grind. */
const MAX_SHED_IMAGES = 32;
/** Tightening rounds when the stable target alone cannot reach the budget. */
const MAX_TIGHTEN_ROUNDS = 3;
/** Wall-clock ceiling for starting new images: this pass runs on the shared event
 *  loop, so a body full of 12MP photos must not freeze every other session. Once
 *  the ceiling is hit the pass stops and whatever fits is sent. */
const MAX_PASS_MS = 4000;
/** Per-image encode memo, the same discipline as image-rescale's encodeCache: the
 *  same screenshots ride every turn of a conversation, and re-encoding them per
 *  turn costs ~1s of blocked event loop each time. Bounded, in-flight deduped. */
const ENCODE_CACHE_MAX = 32;
const encodeCache = new Map<string, Promise<LossyResult | null>>();

function cacheKeyFor(b64: string, capChars: number): string {
    return `${capChars}:${createHash("sha256").update(b64).digest("hex")}`;
}

function rememberEncode(key: string, work: Promise<LossyResult | null>): Promise<LossyResult | null> {
    encodeCache.set(key, work);
    if (encodeCache.size > ENCODE_CACHE_MAX) {
        const oldest = encodeCache.keys().next();
        if (!oldest.done) encodeCache.delete(oldest.value);
    }
    // A failed encode must not become a permanent verdict.
    void work.then((r) => { if (r === null) encodeCache.delete(key); }, () => { encodeCache.delete(key); });
    return work;
}

/** Yield to the event loop between images: encoding is synchronous CPU work, so
 *  without this every other session's stream stalls for the whole pass. */
function yieldToLoop(): Promise<void> {
    return new Promise<void>((resolve) => setImmediate(resolve));
}

export function clearLossyEncodeCache(): void {
    encodeCache.clear();
}

interface JimpLike {
    width: number;
    height: number;
    resize(opts: { w: number; h: number }): Promise<unknown> | unknown;
    getBuffer(mime: string, opts?: Record<string, unknown>): Promise<Buffer>;
    hasAlpha(): boolean;
    bitmap?: { data?: Uint8Array | number[] };
}
interface JimpModule {
    Jimp: { read(data: Buffer): Promise<JimpLike> };
}

let jimpLoad: Promise<JimpModule | null> | undefined;
function loadJimp(): Promise<JimpModule | null> {
    if (jimpLoad === undefined) {
        jimpLoad = import("jimp").then((m) => m as unknown as JimpModule).catch((err: unknown) => {
            loggerLog("warn", `[image-lossy] jimp unavailable (${err instanceof Error ? err.message : String(err)}) — lossy budget disabled for this process`);
            return null;
        });
    }
    return jimpLoad;
}

/** Resolve the budget from the env value: 0/""/non-numeric disables. Pure so the
 *  parsing is pinned without mutating process.env. */
export function resolveLossyBudget(envValue: string | undefined): number | undefined {
    if (envValue === undefined || envValue === "") return IMAGE_LOSSY_DEFAULT_BYTES;
    const parsed = Number(envValue);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.floor(parsed);
}

/** PNG decodes to RGBA, so `hasAlpha()` is true for every opaque screenshot too.
 *  Transparency only matters when a pixel actually carries alpha < 255 — detect
 *  THAT, otherwise every screenshot would be needlessly kept as PNG (and stay
 *  big, defeating the budget). */
function hasRealTransparency(img: JimpLike): boolean {
    const data = img.bitmap?.data;
    if (data === undefined || data === null) return img.hasAlpha();
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 255) return true;
    }
    return false;
}

export interface LossyStats {
    changed: boolean;
    originalBytes: number;
    finalBytes: number;
    /** Images re-encoded, counted once per image (not per attempt). */
    transcoded: number;
    /** Always 0: this rung never drops an image. */
    archived: number;
    /** True when the body is still over budget after the pass — reported, never hidden. */
    stillOverBudget: boolean;
    /** True when the tightening stage had to coarsen images that stage A had left
     *  alone (which invalidates earlier images for the upstream prefix cache). */
    tightened: boolean;
    /** Images left untouched because the wall budget or the work cap was hit. */
    skippedForTime?: number;
}

interface LossyResult {
    b64: string;
    mediaType: string;
}

/** Re-encode ONE image under `capChars` (base64 chars), preserving transparency. */
async function shrinkImageLossy(mediaType: string, b64: string, capChars: number): Promise<LossyResult | null> {
    if (b64.length > MAX_DECODE_CHARS) return null; // bomb, not a screenshot
    const key = cacheKeyFor(b64, capChars);
    const cached = encodeCache.get(key);
    if (cached !== undefined) return cached;
    return rememberEncode(key, encodeOneLossy(mediaType, b64, capChars));
}

async function encodeOneLossy(mediaType: string, b64: string, capChars: number): Promise<LossyResult | null> {
    const mod = await loadJimp();
    if (mod === null) return null;
    const fits = (buf: Buffer): boolean => Math.ceil(buf.length / 3) * 4 <= capChars;
    // Every decode/encode/resize step is contained: one odd image or one jimp bug
    // must degrade to "leave it alone", never abort the request.
    try {
        const img = await mod.Jimp.read(Buffer.from(b64, "base64"));
        const alpha = hasRealTransparency(img);
        const beforeChars = b64.length;
        // Pass 1: quality ladder at native size (opaque only — PNG is lossless).
        if (!alpha) {
            for (const quality of JPEG_QUALITY_LADDER) {
                const out = await img.getBuffer("image/jpeg", { quality });
                if (fits(out)) return { b64: out.toString("base64"), mediaType: "image/jpeg" };
            }
        }
        // Pass 2: shrink geometry. Never above the native size (a floor larger
        // than the image would UPSCALE it) and always strictly smaller per step.
        let width = img.width;
        let height = img.height;
        for (let step = 0; step < 10; step++) {
            if (width <= 1 || height <= 1) break;
            const nextW = Math.min(width - 1, Math.max(1, Math.round(width * 0.8)));
            const nextH = Math.min(height - 1, Math.max(1, Math.round(height * 0.8)));
            if (nextW < MIN_LOSSY_DIM && nextH < MIN_LOSSY_DIM) break; // floor reached
            width = nextW;
            height = nextH;
            await img.resize({ w: width, h: height });
            if (alpha) {
                const png = await img.getBuffer("image/png");
                if (fits(png)) return { b64: png.toString("base64"), mediaType: "image/png" };
            } else {
                for (const quality of [80, 64, 56]) {
                    const jpg = await img.getBuffer("image/jpeg", { quality });
                    if (fits(jpg)) return { b64: jpg.toString("base64"), mediaType: "image/jpeg" };
                }
            }
        }
        // Last effort — the smallest encode we can still produce, if it is smaller.
        const smallest = alpha
            ? await img.getBuffer("image/png")
            : await img.getBuffer("image/jpeg", { quality: 56 });
        const smallestChars = Math.ceil(smallest.length / 3) * 4;
        if (smallestChars < beforeChars) {
            return { b64: smallest.toString("base64"), mediaType: alpha ? "image/png" : "image/jpeg" };
        }
        return null;
    } catch {
        return null; // undecodable / encoder failure — leave the image untouched
    }
}

function toTargets(occ: Occurrence[]): Occurrence[] {
    return occ.filter((o) => !o.archived);
}

/** Re-encode the images in a serialized request until the body fits `budgetBytes`.
 *  Pure on the input STRING; returns it unchanged when nothing needed doing. */
export async function applyLossyImageBudget(
    body: string,
    protocol: WireProtocol,
    budgetBytes: number,
): Promise<{ body: string; stats: LossyStats }> {
    const originalBytes = Buffer.byteLength(body);
    const noop: LossyStats = { changed: false, originalBytes, finalBytes: originalBytes, transcoded: 0, archived: 0, stillOverBudget: false, tightened: false, skippedForTime: 0 };
    if (!Number.isFinite(budgetBytes) || budgetBytes <= 0 || originalBytes <= budgetBytes) return { body, stats: noop };
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return { body, stats: noop };
    }
    if (parsed === null || typeof parsed !== "object") return { body, stats: noop };
    const images = toTargets(collectOccurrences(protocol, parsed as Record<string, unknown>));
    if (images.length === 0) return { body, stats: noop };

    const touched = new Set<Occurrence>();
    const replace = (occ: Occurrence, res: LossyResult): void => {
        occ.applyReplace(res.b64, res.mediaType);
        // Keep the in-memory occurrence in step with the JSON, or the next round
        // re-encodes the ORIGINAL and the byte accounting lies.
        occ.b64 = res.b64;
        occ.mediaType = res.mediaType;
        touched.add(occ);
    };
    const serializeBytes = (): number => Buffer.byteLength(JSON.stringify(parsed));

    // Stage A — set-independent target. Every image above the fixed ceiling is
    // shrunk to it, so one screenshot encodes identically whatever else the turn
    // carries: appending a shot does not invalidate the earlier ones (prefix
    // cache) and does not coarsen pixels the model already described.
    const startedAt = Date.now();
    const byChars = [...images].sort((a, b) => b.b64.length - a.b64.length);
    let worked = 0;
    let skippedForTime = 0;
    for (const occ of byChars) {
        if (worked >= MAX_SHED_IMAGES) { skippedForTime++; continue; }
        if (occ.b64.length <= IMAGE_LOSSY_PER_IMAGE_CHARS) continue;
        if (Date.now() - startedAt > MAX_PASS_MS) { skippedForTime++; continue; }
        worked++;
        const res = await shrinkImageLossy(occ.mediaType, occ.b64, IMAGE_LOSSY_PER_IMAGE_CHARS);
        if (res !== null) replace(occ, res);
        await yieldToLoop();
    }
    let finalBytes = serializeBytes();

    // Stage B — only when the stable target was not enough: a shared cap derived
    // from the budget. This DOES coarsen earlier images (so it costs prefix
    // cache), which is why it is a second stage and reported as `tightened`.
    let tightened = false;
    for (let round = 0; round < MAX_TIGHTEN_ROUNDS && finalBytes > budgetBytes; round++) {
        tightened = true;
        const capChars = Math.max(MIN_PER_IMAGE_BYTES, Math.floor(budgetBytes / Math.max(1, images.length)));
        let changedThisRound = false;
        for (const occ of images) {
            if (occ.b64.length <= capChars) continue;
            if (Date.now() - startedAt > MAX_PASS_MS) break;
            const res = await shrinkImageLossy(occ.mediaType, occ.b64, capChars);
            if (res === null) continue;
            if (res.b64.length >= occ.b64.length) continue;
            replace(occ, res);
            changedThisRound = true;
            await yieldToLoop();
        }
        finalBytes = serializeBytes();
        if (!changedThisRound) break;
    }

    if (touched.size === 0) {
        loggerLog("warn", `[image-lossy] body is ${(originalBytes / 1048576).toFixed(1)}MiB (budget ${(budgetBytes / 1048576).toFixed(1)}MiB) but no image could be re-encoded — forwarding it unchanged`);
        return { body, stats: { ...noop, stillOverBudget: true } };
    }
    const out = JSON.stringify(parsed);
    return {
        body: out,
        stats: {
            changed: true,
            originalBytes,
            finalBytes: Buffer.byteLength(out),
            transcoded: touched.size,
            archived: 0,
            stillOverBudget: finalBytes > budgetBytes,
            tightened,
            skippedForTime,
        },
    };
}
