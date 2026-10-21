/**
 * #3762/#4069 media CAS split — pure helpers shared by the ingest planners
 * (split side) and the store hydrators (read side).
 *
 * The kernel's OpenAI codec stores each image TWICE on one core message: the
 * `imageBase64`/`imageMediaType` sidecar AND the verbatim wire part under
 * `rawOpenaiContent` / `rawOpenaiContentParts` (kernel/src/wire/openai.ts —
 * the rebuild prefers the raw part over the sidecar, so both must exist).
 * Storing both copies inline defeats #3762's dedup: on a real 11 GB corpus
 * the split yielded 1.89× instead of 33.8× (#4069), and master's codec still
 * produces both fields, so fresh installs inherit the duplication. Both
 * copies therefore ride the content CAS:
 *
 *  - the sidecar slot becomes {"$media": sha256(b64)} (key position kept);
 *  - every raw-wire data URL becomes `data:<type>;base64,$media:<hash>` —
 *    the reference is embedded in the url STRING itself (`$` is outside the
 *    base64 alphabet, so a placeholder can never collide with real payload
 *    bytes). No sibling key, no new top-level slot: the stored JSON keeps
 *    the exact key set of the original, so hydrate-and-restringify stays
 *    byte-identical to the pre-split serialization and every reader that
 *    parses urls as strings keeps working unhydrated-shape-free.
 *
 * Splitting is gated twice:
 *  - SIZE: below MIN_SPLIT_MEDIA_CHARS the 77-char reference plus the CAS
 *    row and its mapping row cost more than the payload;
 *  - STRICT CANONICAL FORM: reconstruction `data:<type>;base64,<payload>`
 *    must be byte-exact. The kernel's loose parseDataUrl also accepts a
 *    missing ;base64 marker, extra params and case-folded schemes — those
 *    round-trip to DIFFERENT strings through the sidecar fallback, so such
 *    urls stay inline untouched (the raw copy may be the only carrier).
 */

import { createHash } from "node:crypto";

/** #4069: base64 payloads shorter than this (in characters) stay inline.
 *  Splitting adds a constant overhead (~77-char ref + CAS row + mapping
 *  row ≈ 200 B) independent of payload size; measured corpora put >99% of
 *  image bytes in blobs far above this floor. */
export const MIN_SPLIT_MEDIA_CHARS = 65_536;

// One-line local copy rather than importing from ./store.js — store.ts
// imports the hydrate helpers from HERE, and a crypto one-liner does not
// justify breaking the cycle the other way.
const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Strict canonical data URL. No /i (the kernel's parseDataUrl is loose on
 *  purpose; the split gate must not be): reconstruction is byte-exact by
 *  construction for anything this matches. */
const CANONICAL_DATA_URL = /^data:([^;,]+);base64,(.+)$/;

/** A split raw-wire url: `data:<type>;base64,$media:<sha256hex>` (exported
 *  for the async hydrate twin in mysql.ts). */
export const SPLIT_MEDIA_URL = /^data:([^;,]+);base64,\$media:([0-9a-f]{64})$/;

/** Fast-path markers: content lacking ALL of these cannot carry splittable
 *  media (split side) or hydrated refs (read side) — skip the JSON.parse.
 *  The quoted "rawOpenaiContent" does NOT match the Parts variant, hence
 *  all three entries. */
const SPLIT_MARKERS = ["\"imageBase64\"", "\"rawOpenaiContent\"", "\"rawOpenaiContentParts\""];
export const HYDRATE_MARKERS = ["\"$media\"", "$media:"];

export interface MediaRef { hash: string; bytes: string }

interface RawOpenaiImagePart { image_url: { url: unknown } }

/** True when v is a split-form slot value: an object whose only job is to
 *  carry a CAS hash under $media. */
export function isMediaRef(v: unknown): v is { $media: string } {
    return v !== null && typeof v === "object" && !Array.isArray(v) && typeof (v as { $media?: unknown }).$media === "string";
}

/** Collects the raw OpenAI wire image parts of a parsed message — the
 *  singular carrier plus the plural array (legacy multi-image shapes).
 *  Returned objects are references INTO the parsed message: mutating their
 *  image_url.url lands on the message itself. Developer-role messages reuse
 *  rawOpenaiContent for the whole original message object — filtered out by
 *  the type check below. */
export function collectRawOpenaiImageParts(msg: Record<string, unknown>): RawOpenaiImagePart[] {
    const out: RawOpenaiImagePart[] = [];
    const push = (c: unknown): void => {
        if (c === null || typeof c !== "object") return;
        const p = c as { type?: unknown; image_url?: unknown };
        if (p.type !== "image_url" || p.image_url === null || typeof p.image_url !== "object") return;
        out.push(p as unknown as RawOpenaiImagePart);
    };
    if (msg.rawOpenaiContent !== undefined) push(msg.rawOpenaiContent);
    if (Array.isArray(msg.rawOpenaiContentParts)) for (const c of msg.rawOpenaiContentParts) push(c);
    return out;
}

/** #3762/#4069: pull every qualifying media payload out of the serialized
 *  message. See the module header for the two stored reference shapes and
 *  the size/canonical gates. Same-hash payloads are interned into ONE CAS
 *  entry (the dual-field case: sidecar and raw url share a row). No
 *  qualifying media → passthrough with the plain content hash, original
 *  bytes untouched. */
export function splitMediaContent(content: string): { content: string; hash: string; media: MediaRef[] } {
    if (!SPLIT_MARKERS.some((k) => content.includes(k))) return { content, hash: sha256Hex(content), media: [] };
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
        return { content, hash: sha256Hex(content), media: [] };
    }
    const byHash = new Map<string, string>();
    const intern = (b64: string): string => {
        const h = sha256Hex(b64);
        if (!byHash.has(h)) byHash.set(h, b64);
        return h;
    };
    // Slot 1: the top-level imageBase64 sidecar (#3762).
    const b64 = parsed.imageBase64;
    if (typeof b64 === "string" && b64.length >= MIN_SPLIT_MEDIA_CHARS) {
        parsed.imageBase64 = { $media: intern(b64) };
    }
    // Slot 2: the raw OpenAI wire data URLs carrying the same payloads (#4069).
    for (const part of collectRawOpenaiImageParts(parsed)) {
        const url = part.image_url.url;
        if (typeof url !== "string") continue;
        const m = CANONICAL_DATA_URL.exec(url);
        if (!m || m[2].length < MIN_SPLIT_MEDIA_CHARS) continue;
        part.image_url.url = `data:${m[1]};base64,$media:${intern(m[2])}`;
    }
    if (byHash.size === 0) return { content, hash: sha256Hex(content), media: [] };
    const split = JSON.stringify(parsed);
    return { content: split, hash: sha256Hex(split), media: [...byHash.entries()].map(([hash, bytes]) => ({ hash, bytes })) };
}

/** Read-side inverse of splitMediaContent: swap every media reference back
 *  to its CAS bytes — the {"$media"} sidecar slot AND the embedded
 *  `$media:` refs inside raw-wire urls. Returns the ORIGINAL string
 *  unchanged when nothing hydrated (missing CAS rows fall back to the split
 *  form rather than throwing — visible, not silent, same discipline as
 *  #3762). Key order is preserved by parse/stringify and no key is ever
 *  added or removed, so the result is byte-identical to the pre-split
 *  serialization. */
export function hydrateMediaRefs(content: string, getBytes: (hash: string) => string | null | undefined): string {
    if (!HYDRATE_MARKERS.some((k) => content.includes(k))) return content;
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
        return content;
    }
    let changed = false;
    const slot = parsed.imageBase64;
    if (isMediaRef(slot)) {
        const bytes = getBytes(slot.$media);
        if (typeof bytes === "string" && bytes.length > 0) {
            parsed.imageBase64 = bytes;
            changed = true;
        }
    }
    for (const part of collectRawOpenaiImageParts(parsed)) {
        const m = typeof part.image_url.url === "string" ? SPLIT_MEDIA_URL.exec(part.image_url.url) : null;
        if (!m) continue;
        const bytes = getBytes(m[2]);
        if (typeof bytes === "string" && bytes.length > 0) {
            part.image_url.url = `data:${m[1]};base64,${bytes}`;
            changed = true;
        }
    }
    if (!changed) return content;
    try {
        return JSON.stringify(parsed);
    } catch {
        return content;
    }
}
