/** Lossy image budget: keep the pictures, drop the bytes.
 *
 *  A turn whose bulk is screenshots can be refused by an upstream for SIZE. The
 *  measured case: 6 shots at 1264x805 (inside the 1600px rescale gate, so the
 *  normal pass correctly leaves them alone) = 4.88MiB of PNG, ~7.0MiB of body,
 *  resets in 0.2-0.5s while every request under ~6MiB passed. Lossless
 *  re-encoding those PNGs makes them ~16% BIGGER; JPEG q88 makes them ~73%
 *  smaller. So the only lever that keeps the turn deliverable is lossy — an
 *  explicit owner decision, not a default we take silently.
 *
 *  Invariants (pinned in tests/image-lossy-budget.test.ts):
 *   - under the budget: the body is returned untouched, byte for byte;
 *   - over it: images stay PRESENT (never archived) — the model keeps the
 *     picture, just softer, which beats "no image at all";
 *   - an image with transparency is never JPEG'd (that would flatten alpha);
 *     it is downscaled as PNG instead;
 *   - the `acp_read_original_image` receipt lane is exempt (collectOccurrences
 *     enforces it) — that lane exists to fetch full fidelity on demand;
 *   - the ORIGINAL image is never touched: only this wire copy changes, and the
 *     stored session keeps the untouched bytes.
 */
import { collectOccurrences, type Occurrence } from "./egress-shed.js";
import { log as loggerLog } from "./logger.js";
import type { WireProtocol } from "./util.js";

/** Default trigger: measured pass/fail cliff in the reported incident was
 *  ">= 6MiB: 29/44 failed; 4-6MiB: 0/28" — start below the cliff, not at it. */
export const IMAGE_LOSSY_DEFAULT_BYTES = 5 * 1024 * 1024;
/** JPEG quality ladder, best first — stop at the first rung that fits. */
const JPEG_QUALITY_LADDER = [88, 80, 72, 64, 56];
/** Resolution floor when a quality rung alone cannot reach the per-image cap. */
const MIN_LOSSY_DIM = 320;
/** Per-image floor: never chase the budget so hard a screenshot becomes unreadable. */
const MIN_PER_IMAGE_BYTES = 120 * 1024;

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

export interface ImageShedPolicyInput {
    env: string | undefined;
    config: number | undefined;
}

/** Resolve the budget: env > config file > 6MiB default; 0/false/"0" disables. */
export function imageShedPolicy(input: ImageShedPolicyInput): { budgetBytes: number | undefined } {
    const raw = input.env !== undefined ? input.env : input.config;
    if (raw === undefined || raw === "") return { budgetBytes: IMAGE_LOSSY_DEFAULT_BYTES };
    const parsed = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return { budgetBytes: undefined };
    return { budgetBytes: Math.floor(parsed) };
}

export interface LossyStats {
    changed: boolean;
    originalBytes: number;
    finalBytes: number;
    /** Images re-encoded (JPEG or PNG downscale). */
    transcoded: number;
    /** Always 0: this rung never drops an image. */
    archived: number;
}

interface LossyResult {
    b64: string;
    mediaType: string;
}

/** Re-encode ONE image under `capBytes`, preserving transparency when present. */
async function shrinkImageLossy(mediaType: string, b64: string, capBytes: number): Promise<LossyResult | null> {
    const mod = await loadJimp();
    if (mod === null) return null;
    let img: JimpLike;
    try {
        img = await mod.Jimp.read(Buffer.from(b64, "base64"));
    } catch {
        return null; // undecodable (exotic container) — leave it alone
    }
    const alpha = hasRealTransparency(img);
    // Every cap below is measured in BASE64 characters, because that is what the
    // request body actually carries: a 657KB JPEG is 877KB once encoded, and
    // comparing raw bytes to a base64 budget silently overshoots by 4/3.
    const fits = (buf: Buffer): boolean => Math.ceil(buf.length / 3) * 4 <= capBytes;
    const beforeChars = b64.length;
    let width = img.width;
    let height = img.height;
    // Pass 1: quality ladder at native size (opaque images only — PNG is lossless).
    if (!alpha) {
        for (const quality of JPEG_QUALITY_LADDER) {
            const out = await img.getBuffer("image/jpeg", { quality });
            if (fits(out)) return { b64: out.toString("base64"), mediaType: "image/jpeg" };
        }
    }
    // Pass 2: downscale (keeps alpha intact for PNG) until the cap is met.
    for (let step = 0; step < 8; step++) {
        const nextW = Math.max(MIN_LOSSY_DIM, Math.round(width * 0.8));
        const nextH = Math.max(MIN_LOSSY_DIM, Math.round(height * 0.8));
        if (nextW === width && nextH === height) break;
        width = nextW;
        height = nextH;
        await img.resize({ w: width, h: height });
        if (alpha) {
            const png = await img.getBuffer("image/png");
            if (fits(png)) return { b64: png.toString("base64"), mediaType: "image/png" };
        } else {
            for (const quality of [80, 64]) {
                const jpg = await img.getBuffer("image/jpeg", { quality });
                if (fits(jpg)) return { b64: jpg.toString("base64"), mediaType: "image/jpeg" };
            }
        }
    }
    if (!alpha) {
        const smallest = await img.getBuffer("image/jpeg", { quality: 56 });
        const smallestChars = Math.ceil(smallest.length / 3) * 4;
        if (smallestChars < beforeChars) return { b64: smallest.toString("base64"), mediaType: "image/jpeg" };
    }
    return null;
}

function toOccurrenceTargets(occ: Occurrence[]): Occurrence[] {
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
    const noop: LossyStats = { changed: false, originalBytes, finalBytes: originalBytes, transcoded: 0, archived: 0 };
    if (!Number.isFinite(budgetBytes) || budgetBytes <= 0 || originalBytes <= budgetBytes) return { body, stats: noop };
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return { body, stats: noop };
    }
    if (parsed === null || typeof parsed !== "object") return { body, stats: noop };
    const occurrences = toOccurrenceTargets(collectOccurrences(protocol, parsed as Record<string, unknown>));
    if (occurrences.length === 0) return { body, stats: noop };

    // Uniform, not greedy: shrinking only the biggest shot until the body fits
    // leaves one 360KB JPEG next to 1.1MB PNGs, so the same turn carries wildly
    // different legibility per image. Every image over the shared cap is
    // re-encoded, which keeps the set consistent and the outcome predictable.
    const images = occurrences;
    let capChars = Math.max(MIN_PER_IMAGE_BYTES, Math.floor(budgetBytes / images.length));
    let estimated = originalBytes;
    let transcoded = 0;
    for (let round = 0; round < 3; round++) {
        let roundChanged = false;
        for (const occ of images) {
            const before = Buffer.byteLength(occ.b64);
            if (before <= capChars) continue;
            const shrunk = await shrinkImageLossy(occ.mediaType, occ.b64, capChars);
            if (shrunk === null) continue;
            const after = Buffer.byteLength(shrunk.b64);
            if (after >= before) continue; // never pay fidelity for nothing
            occ.applyReplace(shrunk.b64, shrunk.mediaType);
            estimated += after - before;
            transcoded++;
            roundChanged = true;
        }
        if (!roundChanged || estimated <= budgetBytes) break;
        if (round === 2) break;
        // Still over: tighten the shared cap by the demonstrated overshoot.
        const shortfall = budgetBytes / Math.max(1, estimated);
        capChars = Math.max(MIN_PER_IMAGE_BYTES, Math.floor(capChars * shortfall * 0.95));
    }
    if (transcoded === 0) return { body, stats: noop };
    const out = JSON.stringify(parsed);
    return { body: out, stats: { changed: true, originalBytes, finalBytes: Buffer.byteLength(out), transcoded, archived: 0 } };
}
