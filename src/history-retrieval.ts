// acp_history — read STORED conversation history that is no longer visible.
//
// The gap this closes: bili's folding never destroys anything, and DSH's own
// compaction only replaces the CLIENT's view. Once the host compacts, early
// messages stop riding the request, so `decompress` (block addressed) has no
// block covering them and `search_context` (summary addressed) has no summary
// for them — the model can see that history existed but not what it said.
// Storage still has every body (#4738): `messages` + `content` outlive the
// resident window. This tool is the read side.
//
// SIZE DISCIPLINE — the reason a naive "give me the history" tool is unusable:
//   1. Search returns SNIPPETS (bounded window around the match), never whole
//      messages. Budget = limit x ~240 chars regardless of message sizes.
//   2. Range mode assembles messages against a hard byte cap and hands back a
//      `next` cursor for the remainder — no single call can flood the context.
//   3. A single oversized message is truncated head/tail with an explicit
//      marker rather than either dropped or pasted whole.
//   4. The scan budget is bounded too: `searched the newest K of N` is always
//      reported, and `before: seq` walks further back. "Not found in K" never
//      masquerades as "not found in history".

import { getStore } from "./persist.js";
import { toolFail, toolOk, type ProxyToolResult } from "./proxy-tool-result.js";
import type { MessageRefContentRow, MessageTextSearchResult } from "./storage/store.js";

/** Default/max hits returned by search mode. */
const DEFAULT_HITS = 8;
const MAX_HITS = 20;
/** Default/max stored messages SCANNED per search call (newest first). */
const DEFAULT_SCAN = 4000;
const MAX_SCAN = 20000;
/** Inline byte budget for range mode (the anti-flood knob). */
const DEFAULT_BYTES = 24_000;
const MAX_BYTES = 200_000;
/** Hard cap on messages pulled into ONE range call. */
const MAX_REFS = 400;
/** Snippet window: characters of context each side of the first match. */
const SNIPPET_BEFORE = 100;
const SNIPPET_AFTER = 140;

export type HistoryLookupDeps = {
    refRows: (sessionId: string, refNums: readonly number[]) => MessageRefContentRow[] | null;
    search: (sessionId: string, needles: readonly string[], opts: { limit: number; scanLimit: number; beforeSeq?: number }) => MessageTextSearchResult | null;
};

function defaultDeps(): HistoryLookupDeps {
    const store = getStore();
    return {
        refRows: (sessionId, refNums) => store.unifiedMessageContentByRefs(sessionId, refNums),
        search: (sessionId, needles, opts) => store.unifiedSearchMessageText(sessionId, needles, opts),
    };
}

const UNAVAILABLE = "[acp_history FAILED: the unified storage index is unavailable on this proxy — stored history cannot be read. (Compression still works; only history retrieval is disabled.)]";

function refOf(n: number): string {
    return `m${String(n).padStart(5, "0")}`;
}

/** Accept m00423, "423", 423, "M423" — anything else is not a ref. */
export function parseRefNum(raw: unknown): number | null {
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
    if (typeof raw === "string") {
        const m = /^[mM]?(\d{1,9})$/.exec(raw.trim());
        if (m) return Number(m[1]);
    }
    return null;
}

/** Code-unit-safe middle slice — never leaves a lone surrogate at an edge
 *  (same discipline as every other hand-sliced model-visible text). */
function midSlice(text: string, start: number, end: number): string {
    let s = Math.max(0, start);
    let e = Math.min(text.length, Math.max(s, end));
    if (s > 0 && s < text.length) {
        const c = text.charCodeAt(s);
        if (c >= 0xdc00 && c <= 0xdfff) s += 1;
    }
    if (e > 0 && e < text.length) {
        const c = text.charCodeAt(e - 1);
        if (c >= 0xd800 && c <= 0xdbff) e -= 1;
    }
    return text.slice(s, e);
}

/** Stored bodies may be raw text or the wire message object; surface the text
 *  field when there is one so the model reads prose, not JSON. */
export function readableMessageText(content: string): string {
    if (!content.startsWith("{")) return content;
    try {
        const o = JSON.parse(content) as Record<string, unknown>;
        for (const key of ["text", "content", "thinking"]) {
            const v = o[key];
            if (typeof v === "string" && v.length > 0) return v;
        }
    } catch {
        // not JSON after all — fall through to the raw body
    }
    return content;
}

function bytesOf(text: string): number {
    return Buffer.byteLength(text, "utf8");
}

/** Bounded preview centred on the first matched needle, match bracketed with
 *  【】 so a snippet proves WHY it matched. */
export function snippetOf(text: string, needles: readonly string[]): string {
    const hay = text.toLowerCase();
    let idx = -1;
    let hitLen = 0;
    for (const n of needles) {
        const i = hay.indexOf(n.toLowerCase());
        if (i !== -1 && (idx === -1 || i < idx)) {
            idx = i;
            hitLen = n.length;
        }
    }
    if (idx === -1) {
        return text.length > SNIPPET_BEFORE + SNIPPET_AFTER ? `${midSlice(text, 0, SNIPPET_BEFORE + SNIPPET_AFTER)}…` : text;
    }
    const start0 = Math.max(0, idx - SNIPPET_BEFORE);
    const end0 = Math.min(text.length, idx + hitLen + SNIPPET_AFTER);
    const win = midSlice(text, start0, end0);
    // midSlice shifts the start inward by one when the window boundary splits a
    // surrogate pair, so relative offsets computed from start0 would bracket
    // the match one code unit early on every emoji/CJK-adjacent hit.
    const shifted = text.startsWith(win, start0) ? 0 : 1;
    const rel = Math.max(0, Math.min(win.length, idx - start0 - shifted));
    const marked = win.slice(0, rel) + "\u3010" + win.slice(rel, rel + hitLen) + "\u3011" + win.slice(rel + hitLen);
    return (start0 > 0 ? "\u2026" : "") + marked + (end0 < text.length ? "\u2026" : "");
}

function header(role: string, kind: string, chars: number): string {
    return `(${role}${kind && kind !== "message" ? ` · ${kind}` : ""} · ${chars.toLocaleString("en-US")} chars)`;
}

type RangePlan = { from: number; to: number; cappedAt: number | null };

function planRange(args: Record<string, unknown>): RangePlan | string {
    const from = parseRefNum(args.from);
    if (from === null) return "from must be an mNNNNN ref (e.g. \"m00423\")";
    const toRaw = args.to === undefined ? from : parseRefNum(args.to);
    if (toRaw === null) return "to must be an mNNNNN ref (e.g. \"m00480\")";
    if (toRaw < from) return `to (${refOf(toRaw)}) is before from (${refOf(from)}) — swap them`;
    const span = toRaw - from + 1;
    if (span > MAX_REFS) return `that span is ${span} message(s); one call reads at most ${MAX_REFS} — pass to=${refOf(from + MAX_REFS - 1)} and continue from there`;
    return { from, to: toRaw, cappedAt: null };
}

/** Assemble range rows under `maxBytes`, returning the continuation cursor. */
export function renderRange(
    rows: readonly MessageRefContentRow[],
    maxBytes: number,
): { text: string; nextRef: number | null; shown: number } {
    const parts: string[] = [];
    let used = 0;
    let shown = 0;
    let nextRef: number | null = null;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const body = readableMessageText(row.content);
        const head = `${refOf(row.refNum)} ${header(row.role, row.kind, body.length)}`;
        const block = `${head}\n${body}`;
        const cost = bytesOf(block) + 2;
        if (used + cost <= maxBytes) {
            parts.push(block);
            used += cost;
            shown += 1;
            continue;
        }
        // First item already over budget: truncate it rather than returning
        // nothing (a 40 KB tool result must still be readable in part).
        if (shown === 0) {
            const budget = Math.max(512, maxBytes - bytesOf(head) - 200);
            const headPart = Math.floor(budget * 0.6);
            const tailPart = budget - headPart;
            const truncated = `${midSlice(body, 0, headPart)}\n\n[… truncated: showing ${(headPart + tailPart).toLocaleString("en-US")} of ${body.length.toLocaleString("en-US")} chars. This message alone is ${bytesOf(body).toLocaleString("en-US")} bytes — re-issue with the same from/to to re-read it, pass a larger maxBytes (up to ${MAX_BYTES.toLocaleString("en-US")}), or read the full body out of storage with the client's file tools.]\n\n${body.length > tailPart ? midSlice(body, body.length - tailPart, body.length) : ""}`;
            parts.push(`${head}\n${truncated}`);
            shown = 1;
            nextRef = i + 1 < rows.length ? rows[i + 1].refNum : null;
        } else {
            nextRef = row.refNum;
        }
        break;
    }
    return { text: parts.join("\n\n"), nextRef, shown };
}

function runSearch(args: Record<string, unknown>, sessionId: string, deps: HistoryLookupDeps): ProxyToolResult {
    const query = String(args.query ?? "").trim();
    const needles = query.split(/\s+/).filter(Boolean);
    if (needles.length === 0) return toolFail("[acp_history FAILED: query is required for search mode]");
    const limit = clampInt(args.limit, DEFAULT_HITS, 1, MAX_HITS);
    const scanLimit = clampInt(args.scan, DEFAULT_SCAN, 1, MAX_SCAN);
    const beforeSeq = typeof args.before === "number" && Number.isFinite(args.before) ? Math.floor(args.before) : undefined;
    const found = deps.search(sessionId, needles, { limit, scanLimit, beforeSeq });
    if (found === null) return toolFail(UNAVAILABLE);
    if (found.total === 0) return toolOk("[acp_history: no stored messages for this session — nothing to search.]");
    // An empty result is an ANSWER, and it must say how much ground it covered.
    if (found.hits.length === 0) {
        const scope = beforeSeq !== undefined ? `ending before seq ${beforeSeq}` : "newest first";
        const resume = found.scannedTo !== null ? `before: ${found.scannedTo}` : "before: <the seq a receipt reported>";
        return toolOk(
            `[acp_history: no match for "${query}" in the newest ${found.scanned.toLocaleString("en-US")} of ${found.total.toLocaleString("en-US")} stored message(s) (${scope}).\n` +
                (found.capped
                    ? `The scan budget stopped at ${found.scanned.toLocaleString("en-US")} — older messages were NOT searched. Re-issue with ${resume} to continue backward.\n`
                    : "That is the whole stored history — absent here means absent, not unsearched.\n") +
                "Search matches message BODIES only (case-insensitive, all terms must appear in one message).]",
        );
    }
    const lines = found.hits.map((h) => {
        const body = readableMessageText(h.content);
        return `${refOf(h.refNum)} ${header(h.role, h.kind, body.length)}\n  ${snippetOf(body, needles).replace(/\n/g, "\n  ")}`;
    });
    const oldest = found.hits[found.hits.length - 1];
    const more = found.capped
        ? `\n\n[searched the newest ${found.scanned.toLocaleString("en-US")} of ${found.total.toLocaleString("en-US")} — older messages were NOT searched. Continue with before: ${oldest.seq}.]`
        : found.hits.length >= limit
          ? `\n\n[stopped at limit:${limit} hit(s) — pass limit:${Math.min(MAX_HITS, limit * 2)} for more, or narrow the query.]`
          : "";
    return toolOk(
        `[acp_history search "${query}": ${found.hits.length} hit(s) in ${found.scanned.toLocaleString("en-US")} of ${found.total.toLocaleString("en-US")} stored message(s)]\n\n` +
            `${lines.join("\n\n")}${more}\n\n` +
            "[Snippets only — fetch full text with acp_history({from,to}) on the refs you need: {from:\"" +
            refOf(oldest.refNum) +
            '", to:"' +
            refOf(found.hits[0].refNum) +
            '"}].]',
    );
}

function runRange(args: Record<string, unknown>, sessionId: string, deps: HistoryLookupDeps): ProxyToolResult {
    const plan = planRange(args);
    if (typeof plan === "string") return toolFail(`[acp_history FAILED: ${plan}]`);
    const maxBytes = clampInt(args.maxBytes, DEFAULT_BYTES, 1024, MAX_BYTES);
    const refs: number[] = [];
    for (let r = plan.from; r <= plan.to; r++) refs.push(r);
    const rows = deps.refRows(sessionId, refs);
    if (rows === null) return toolFail(UNAVAILABLE);
    if (rows.length === 0) {
        return toolOk(
            `[acp_history: no stored message found for ${refOf(plan.from)}${plan.to !== plan.from ? `–${refOf(plan.to)}` : ""}. Refs are the mNNNNN ids visible in your history; storage keeps every body it has seen, so an unknown ref usually means a typo or a ref from a different session.]`,
        );
    }
    const { text, nextRef, shown } = renderRange(rows, maxBytes);
    const missing = plan.to - plan.from + 1 - rows.length;
    const notes: string[] = [];
    if (missing > 0) notes.push(`${missing} ref(s) in that span have no stored row`);
    if (nextRef !== null) notes.push(`continue with from:"${refOf(nextRef)}"`);
    const tail = notes.length > 0 ? `\n\n[${notes.join(" · ")}]` : "";
    return toolOk(`[acp_history ${refOf(plan.from)}–${refOf(plan.to)}: ${shown}/${rows.length} stored message(s)]\n\n${text}${tail}`);
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
    const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : fallback;
    return Math.max(min, Math.min(max, n));
}

/** Resolve the target session: `session` when given, else the calling session.
 *  Foreign ids are read-only by construction (nothing here mutates). */
function targetSession(args: Record<string, unknown>, sessionId: string): string {
    const raw = args.session;
    return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : sessionId;
}

export function executeHistoryLookup(args: Record<string, unknown>, sessionId: string, deps?: Partial<HistoryLookupDeps>): ProxyToolResult {
    const resolved: HistoryLookupDeps = { ...defaultDeps(), ...deps };
    const target = targetSession(args, sessionId);
    const hasQuery = typeof args.query === "string" && args.query.trim().length > 0;
    const hasRange = args.from !== undefined || args.to !== undefined;
    if (hasQuery) return runSearch(args, target, resolved);
    if (hasRange) return runRange(args, target, resolved);
    return toolFail('[acp_history FAILED: pass either {query} (keyword search over stored message bodies) or {from,to} (full text of an mNNNNN range)]');
}
