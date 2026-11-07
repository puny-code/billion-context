/**
 * Host-native compaction FIT — fits a compaction summarize call's body under
 * the model's context window before it is handed to the provider.
 *
 * A host-owned compaction call (`nativeCompactionPassthrough`) replays the
 * conversation the host wants summarized and appends its summarization
 * directive. By construction that body is the WHOLE history — the one request
 * that can exceed the window even when every individual turn fits. DSH's
 * compaction hand-back goes straight to the provider (bili's proxy deliberately
 * relays such calls verbatim, src/server/handle.ts "dsh native compaction —
 * relaying verbatim, kernel bypassed"), so an 8,650-message session replayed
 * ~1,972,454 tokens against a 1,048,576-token model and the upstream rejected
 * every auto-compaction attempt:
 *
 *   compaction/end 400 [invalid_request_error] Input too long: model limit
 *   1048576 tokens, requested 1972454 tokens
 *   turn/end CONTEXT_WINDOW_EXCEEDED
 *
 * This module builds the replacement body for exactly that case: the leading
 * system/instruction block is preserved, the newest messages are preserved
 * verbatim, and everything older collapses into ONE clearly marked placeholder
 * message. Nothing else in the JSON is rewritten — the `messages`/`input`
 * array value is spliced into the ORIGINAL text, so model/max_tokens/tools/
 * stream/… stay byte-identical (a pretty-printed envelope keeps its exact
 * formatting everywhere outside the array).
 *
 * Message legality is preserved by construction:
 *  - the kept tail is a CONTIGUOUS slice of the original array, so every
 *    tool_call/tool_result pair inside it is untouched;
 *  - a cut never lands on a tool-result carrier (anthropic tool_result block,
 *    openai `tool`/`function` role, responses `function_call_output`), so a
 *    pair can never be split across the placeholder — the cut just moves on to
 *    the next legal boundary (one extra message dropped rather than a broken
 *    pair);
 *  - for strict-alternation wires (anthropic) the placeholder's role is chosen
 *    so the join stays legal (assistant placeholder after a preserved user
 *    instruction, user placeholder before a kept assistant message).
 *
 * Fail-open everywhere: any shape this module cannot reason about returns
 * undefined and the caller keeps its pre-existing behavior (send verbatim).
 */

import { DSH_COMPACTION_MARKER_SNIFF, isDshCompactionCall } from "../server/dsh-compaction-guard.js";

/** A direct send is only treated as PROVABLY too large above this fraction of
 *  the declared window. `bytes / 4` is an optimistic token estimate (real
 *  tokenizers cost at least as much per byte for prose and considerably more
 *  for CJK), so a body that does not clear this bar may still fit and is left
 *  untouched. */
export const COMPACTION_FIT_TRIGGER_RATIO = 0.9;

/** What the fitted body is aimed at, as a fraction of the declared window:
 *  enough headroom for the summarizer's own output and for the error in the
 *  `bytes / 4` estimate. */
export const COMPACTION_FIT_TARGET_RATIO = 0.8;

/** Share of the window held back for the summarizer's own reply. Providers cap
 *  input+output together, so the input ceiling is `window - reply allowance`,
 *  never `window`. This mirrors the headroom policy the proxy already applies
 *  on every other lane (reserve `min(max output, 25% of window)`). */
export const COMPACTION_FIT_OUTPUT_RESERVE_PCT = 0.25;

/** Below this a "reply allowance" is not a budget but a collapse artifact.
 *  The provider layer clamps with `max(1, window - inputEstimate - 4096)`, so a
 *  replay that is already over the window declares exactly 1 — and the upstream
 *  then writes a one-token "summary" the host discards as `summarization
 *  truncated at the token cap`. 256 leaves deliberate small budgets (512, 1024,
 *  8192) untouched while catching the clamp. */
export const COMPACTION_FIT_STARVED_OUTPUT_MAX = 256;

/** What a starved allowance is restored to. DSH's own summarizer cap defaults to
 *  65,536 output tokens; half of that (32k ≈ 128 KB of text) is several times
 *  the observed checkpoint size (3,589 tok / 15,779 chars on a 636k-token
 *  replay) and still finishes in minutes rather than tens of minutes. */
export const COMPACTION_FIT_RESTORED_OUTPUT_TOKENS = 32768;

/** Headroom kept between `input + output` and the window so a tokenizer that
 *  counts a little denser than `bytes / 4` cannot re-trip the ceiling. */
export const COMPACTION_FIT_OUTPUT_SAFETY_TOKENS = 2048;

/** How many times a hand-back may re-cut an already-fitted compaction body
 *  after the provider rejected it for size. Each retry halves the target, so
 *  two attempts reach a quarter of the first one — enough to absorb the 3-4×
 *  gap between `bytes / 4` and a real tokenizer on CJK/base64-heavy replays
 *  without a retry storm. */
export const COMPACTION_FIT_RETRY_LIMIT = 2;

/** How many times a hand-back may lower its reply allowance after the provider
 *  rejected it as above its own maximum output. Kept separate from the size
 *  retries: a provider capped at 8,192 needs 32,768 → 16,384 → 8,192 to
 *  converge, and those attempts must not consume the size budget. */
export const COMPACTION_FIT_CAP_RETRY_LIMIT = 3;

export type CompactionWireProtocol = "anthropic" | "openai" | "responses";

/** The replacement body plus the numbers the caller logs (and tests pin). */
export interface CompactionFitPlan {
    /** JSON text to put on the wire INSTEAD of the original body. */
    body: string;
    protocol: CompactionWireProtocol;
    /** Envelope field the replayed history lives in. */
    field: "messages" | "input";
    /** Replayed message items replaced by the placeholder. */
    droppedMessages: number;
    /** Replay items left verbatim. */
    keptMessages: number;
    droppedBytes: number;
    originalBytes: number;
    fittedBytes: number;
    originalTokens: number;
    fittedTokens: number;
    window: number;
    /** Input ceiling actually used: `window` minus the reply allowance, or the
     *  narrower retry target when the caller re-cut after a rejection. */
    budget: number;
    /** Reply allowance the fitted body actually declares. 0 when the envelope
     *  carries no allowance field at all. Recomputed against the window so
     *  `fittedTokens + outputTokens + safety <= window` always holds. */
    outputTokens: number;
    /** The marker text (also the placeholder message's content). */
    placeholder: string;
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function roleOf(item: unknown): string | undefined {
    return isRec(item) && typeof item.role === "string" ? item.role : undefined;
}

/** The reply allowance the request itself asks for, when it asks for one.
 *  `max_tokens` on the Anthropic and classic OpenAI wires, plus the two names
 *  the newer shapes use. */
function declaredOutputTokens(parsed: Rec): number | undefined {
    for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
        const value = parsed[key];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
    }
    return undefined;
}

export interface ReplyAllowanceRewrite {
    head: string;
    tail: string;
}

/** Rewrite the top-level reply allowance of an already-spliced compaction body,
 *  touching ONLY that scalar. `head`/`tail` are the envelope fragments that sat
 *  before and after the replayed array.
 *
 *  Fail-safe by construction: the rewrite happens only when exactly one of the
 *  three known keys appears exactly once AND its value matches what the parsed
 *  envelope declared. A tool schema that also declares a `max_tokens` property
 *  makes the match ambiguous, and an ambiguous match returns undefined so the
 *  caller keeps today's behaviour instead of rewriting the wrong number. */
export function rewriteReplyAllowance(
    head: string,
    tail: string,
    value: number,
    declared: number | undefined,
): ReplyAllowanceRewrite | undefined {
    const KEYS = ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const;
    const hits: Array<{ where: "head" | "tail"; index: number; length: number; key: string; num: number }> = [];
    const scan = (text: string, where: "head" | "tail"): void => {
        for (const key of KEYS) {
            const re = new RegExp(`(?<=[{,]\\s*)"${key}"\\s*:\\s*(\\d+)`, "g");
            for (const m of text.matchAll(re)) {
                hits.push({ where, index: m.index ?? 0, length: m[0].length, key, num: Number(m[1]) });
            }
        }
    };
    scan(head, "head");
    scan(tail, "tail");
    if (hits.length !== 1) return undefined;
    const hit = hits[0]!;
    if (declared !== undefined && hit.num !== declared) return undefined;
    const replacement = `"${hit.key}": ${value}`;
    if (hit.where === "head") {
        return { head: `${head.slice(0, hit.index)}${replacement}${head.slice(hit.index + hit.length)}`, tail };
    }
    return { head, tail: `${tail.slice(0, hit.index)}${replacement}${tail.slice(hit.index + hit.length)}` };
}

/** True when the body carries the host-compaction directive even though no
 *  protocol parser recognised it (today: google's `generationConfig`). Used only
 *  to log the gap loudly — a silent pass-through is how this class of failure
 *  went unnoticed for two rounds. */
export function looksLikeHostCompaction(raw: string): boolean {
    return raw.includes(DSH_COMPACTION_MARKER_SNIFF);
}

/** The marker line. Deliberately explicit: a reader (or the summarizer) must
 *  be able to tell that history was dropped for size, not by the host — and it
 *  is phrased as an INSTRUCTION because the summarizer is this body's only
 *  reader. Everything downstream sees the summary and nothing else: 6,727
 *  messages replaced here leave no trace in the model's later context unless
 *  the summary itself says they were never read. */
export function placeholderTextOf(dropped: number): string {
    const many = dropped !== 1;
    return `[billion-context: the ${dropped} earlier message${many ? "s" : ""} before this point ${many ? "were" : "was"} NOT included in this request — the conversation exceeds the model's context window. Your summary cannot cover ${many ? "them" : "it"}, and later turns will only ever see your summary. State that omission explicitly in the summary you write, including the count (${dropped} message${many ? "s" : ""} not read).]`;
}

/** Leading system/developer messages — never dropped: they carry the host's
 *  persona, tool contract and (on some wires) the compaction instruction's
 *  framing. */
function leadingSystemCount(items: readonly unknown[]): number {
    let i = 0;
    while (i < items.length) {
        const role = roleOf(items[i]);
        if (role !== "system" && role !== "developer") break;
        i += 1;
    }
    return i;
}

/** True when this item ANSWERS a tool call (or is a bare tool message). A cut
 *  must never start here: the kept tail would begin with an orphan result. */
function consumesToolResult(item: unknown, protocol: CompactionWireProtocol): boolean {
    if (!isRec(item)) return false;
    if (protocol === "responses") return item.type === "function_call_output";
    if (protocol === "openai") {
        if (item.role === "tool" || item.role === "function") return true;
        // Tolerate a responses-shaped item on the chat wire (mixed proxies).
        if (item.type === "function_call_output") return true;
    }
    const content = item.content;
    if (!Array.isArray(content)) return false;
    for (const block of content) {
        if (!isRec(block)) continue;
        if (block.type === "tool_result" || block.type === "function_call_output") return true;
    }
    return false;
}

function placeholderItem(protocol: CompactionWireProtocol, role: "user" | "assistant", dropped: number): Rec {
    const text = placeholderTextOf(dropped);
    if (protocol === "responses") return { type: "message", role, content: [{ type: "input_text", text }] };
    return { role, content: text };
}

/** Last-resort join: no separate placeholder message fits the wire's role
 *  rules, so the marker rides at the HEAD of the first kept message. Roles and
 *  message count stay exactly as they were. */
function mergeMarkerInto(item: unknown, protocol: CompactionWireProtocol, text: string): unknown {
    const next: Rec = isRec(item) ? { ...item } : {};
    const content = next.content;
    if (typeof content === "string") {
        next.content = content === "" ? text : `${text}\n\n${content}`;
        return next;
    }
    if (Array.isArray(content)) {
        const block: Rec = { type: protocol === "responses" ? "input_text" : "text", text };
        next.content = [block, ...content];
        return next;
    }
    next.content = text;
    return next;
}

function skipJsonString(raw: string, from: number): number {
    const n = raw.length;
    let i = from + 1;
    while (i < n) {
        const c = raw.charCodeAt(i);
        if (c === 92 /* \ */) {
            i += 2;
            continue;
        }
        if (c === 34 /* " */) return i + 1;
        i += 1;
    }
    return -1;
}

function skipJsonValue(raw: string, from: number): number {
    const n = raw.length;
    const first = raw[from];
    if (first === '"') return skipJsonString(raw, from);
    if (first === "[" || first === "{") {
        const open = first;
        const close = first === "[" ? "]" : "}";
        let depth = 1;
        let i = from + 1;
        while (i < n) {
            const c = raw[i];
            if (c === '"') {
                const end = skipJsonString(raw, i);
                if (end < 0) return -1;
                i = end;
                continue;
            }
            if (c === open) depth += 1;
            else if (c === close) {
                depth -= 1;
                if (depth === 0) return i + 1;
            }
            i += 1;
        }
        return -1;
    }
    // number / true / false / null
    let i = from;
    while (i < n) {
        const c = raw[i];
        if (c === "," || c === "}" || c === "]" || c === " " || c === "\t" || c === "\r" || c === "\n") break;
        i += 1;
    }
    return i;
}

/** Byte span of the TOP-LEVEL `key` array's value inside the original JSON
 *  text. Splicing that span keeps every other field byte-identical — the
 *  reason this module edits text instead of re-serializing the envelope. */
export function topLevelArraySpanOf(raw: string, key: string): { start: number; end: number } | undefined {
    const n = raw.length;
    const wanted = `"${key}"`;
    let i = raw.indexOf("{");
    if (i < 0) return undefined;
    i += 1;
    while (i < n) {
        while (i < n) {
            const c = raw[i];
            if (c === "," || c === " " || c === "\t" || c === "\r" || c === "\n") i += 1;
            else break;
        }
        if (i >= n || raw[i] === "}") return undefined;
        if (raw[i] !== '"') return undefined;
        const keyEnd = skipJsonString(raw, i);
        if (keyEnd < 0) return undefined;
        const isWanted = raw.slice(i, keyEnd) === wanted;
        i = keyEnd;
        while (i < n) {
            const c = raw[i];
            if (c === " " || c === "\t" || c === "\r" || c === "\n") i += 1;
            else break;
        }
        if (raw[i] !== ":") return undefined;
        i += 1;
        while (i < n) {
            const c = raw[i];
            if (c === " " || c === "\t" || c === "\r" || c === "\n") i += 1;
            else break;
        }
        const valueStart = i;
        const valueEnd = skipJsonValue(raw, i);
        if (valueEnd < 0) return undefined;
        if (isWanted) return raw[valueStart] === "[" ? { start: valueStart, end: valueEnd } : undefined;
        i = valueEnd;
    }
    return undefined;
}

interface FitAttempt {
    /** Items before this index are preserved (system block, maybe the
     *  opening instruction). */
    headEnd: number;
    /** Role of the standalone placeholder message. */
    placeholderRole: "user" | "assistant";
    /** Role the first KEPT item must have for the join to stay legal. */
    requireStart: "user" | "assistant" | undefined;
    /** No standalone placeholder: the marker is merged into the first kept
     *  message instead (role rules cannot be met any other way). */
    merge: boolean;
}

function protocolOf(parsed: unknown): { protocol: CompactionWireProtocol; field: "messages" | "input" } | undefined {
    if (isDshCompactionCall("responses", parsed)) return { protocol: "responses", field: "input" };
    if (isDshCompactionCall("openai", parsed)) return { protocol: "openai", field: "messages" };
    if (isDshCompactionCall("anthropic", parsed)) return { protocol: "anthropic", field: "messages" };
    return undefined;
}

/**
 * Build the fitted body for `raw` (the request JSON text) when it is a
 * host-native compaction call that provably cannot fit `declaredWindow`.
 * Returns undefined when no fit is needed or none can be built safely — the
 * caller then leaves the request exactly as the host sent it.
 */
export function planCompactionFit(
    raw: string,
    declaredWindow: number | undefined,
    /** compaction-fit-retry: an ABSOLUTE input ceiling for this attempt, in the
     *  same `bytes / 4` unit the fit itself works in. The provider still
     *  rejected a body the estimate called in-budget (the wire's tokenizer is
     *  not ours: CJK and base64 cost 3-4× what `bytes / 4` assumes), so the
     *  caller narrows the target and re-cuts rather than guessing a tokenizer.
     *  Absent = the ordinary window-minus-reply target. */
    targetTokens?: number,
    /** compaction-fit-retry: the provider's own maximum output. A restored
     *  allowance above it is rejected as `max_tokens too large`, so the caller
     *  re-plans with a smaller ceiling instead of shrinking the input again. */
    outputCeiling?: number,
): CompactionFitPlan | undefined {
    if (declaredWindow === undefined || !Number.isFinite(declaredWindow) || declaredWindow <= 0) return undefined;
    const window = Math.floor(declaredWindow);
    const originalBytes = Buffer.byteLength(raw);
    const originalTokens = Math.ceil(originalBytes / 4);
    // Stage 1 — cheap, allocation-free: below the trigger ratio there is
    // nothing to do (and no JSON.parse is paid for ordinary traffic).
    if (originalTokens <= window * COMPACTION_FIT_TRIGGER_RATIO) return undefined;
    // Stage 2 — the compaction sniff (the same 48 bytes the server lane
    // uses). A miss is decisive: a conversation that merely QUOTES the
    // directive must never be rewritten, and only isDshCompactionCall's
    // last-user-message rule can tell them apart.
    if (!raw.includes(DSH_COMPACTION_MARKER_SNIFF)) return undefined;

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (!isRec(parsed)) return undefined;
    // The window is shared with the reply. A provider that caps input+output
    // at `window` rejects a body that clears `window` only because the request
    // ALSO asks for a large completion. Live proof: a 27.4 MB compaction replay
    // was fitted to ~830,803 tok against the 1,048,576 window and still came
    // back "Input too long: input exceeds the context limit" — the request
    // declared max_tokens 256,000, so the real input ceiling was 792,576 and
    // the fit had stopped 38,227 tok too late. Budget the fit against what the
    // provider will actually accept, using the same reserve the proxy's
    // headroom policy applies to every other lane.
    const reserveCeiling = Math.floor(window * COMPACTION_FIT_OUTPUT_RESERVE_PCT);
    // The safety pad may never exceed the window's own reply reserve: a window
    // smaller than the constant (the 400-token fixture, tiny local models) has
    // no room for a blanket 2k pad, and demanding one would make every cut
    // illegal there. Unchanged (2,048) for every window >= 8,192.
    const safetyTokens = Math.min(COMPACTION_FIT_OUTPUT_SAFETY_TOKENS, reserveCeiling);
    const declared = declaredOutputTokens(parsed);
    // A starved allowance is a clamp artifact, not intent: budget the reply at a
    // usable size so the checkpoint can be written, and let the input ceiling
    // absorb the difference. The cap keeps a small-window model (e.g. 100k) from
    // reserving a reply budget it cannot afford.
    const starved = declared !== undefined && declared < COMPACTION_FIT_STARVED_OUTPUT_MAX;
    const wantedReply = starved
        ? Math.min(COMPACTION_FIT_RESTORED_OUTPUT_TOKENS, Math.floor(window * 0.4), outputCeiling ?? COMPACTION_FIT_RESTORED_OUTPUT_TOKENS)
        : (declared ?? reserveCeiling);
    const reserved = Math.min(wantedReply, reserveCeiling);
    const budget = Math.max(1, window - reserved);
    // Retry narrowing: never wider than the ordinary budget, and never so small
    // that the kept tail cannot hold the directive (a fit that drops the whole
    // conversation is not a summary request any more).
    const ceiling = targetTokens === undefined
        ? budget
        : Math.max(Math.min(budget, Math.floor(targetTokens)), 1);
    if (originalTokens <= ceiling * COMPACTION_FIT_TRIGGER_RATIO) return undefined;
    const wire = protocolOf(parsed);
    if (wire === undefined) {
        if (looksLikeHostCompaction(raw)) {
            process.emitWarning("[compaction-fit] recognised a host compaction on a wire this build cannot fit (e.g. google generationConfig) — the request is left as-is and may be rejected for size");
        }
        return undefined;
    }
    const { protocol, field } = wire;
    const span = topLevelArraySpanOf(raw, field);
    if (span === undefined) return undefined;
    const items = parsed[field];
    if (!Array.isArray(items)) return undefined;
    const total = items.length;
    const headEnd = leadingSystemCount(items);
    if (total - headEnd < 2) return undefined;

    const targetBytes = Math.floor(ceiling * COMPACTION_FIT_TARGET_RATIO) * 4;
    const itemBytes: number[] = new Array(total).fill(0);
    for (let i = headEnd; i < total; i += 1) {
        const json = JSON.stringify(items[i]);
        itemBytes[i] = Buffer.byteLength(json === undefined ? "null" : json);
    }

    // Attempt order: (1) keep the opening instruction, placeholder on the
    // assistant side, tail must start with a user message; (2) drop the
    // instruction too, placeholder on the user side, tail starts with an
    // assistant message (the classic strict-alternation join); (3) merge the
    // marker into the first kept message when no role arrangement works.
    const attempts: FitAttempt[] = [];
    const opening = roleOf(items[headEnd]);
    if (opening === "user" && headEnd + 1 < total - 1) {
        attempts.push({ headEnd: headEnd + 1, placeholderRole: "assistant", requireStart: "user", merge: false });
    }
    attempts.push({ headEnd, placeholderRole: "user", requireStart: "assistant", merge: false });
    attempts.push({ headEnd, placeholderRole: "user", requireStart: undefined, merge: true });

    for (const attempt of attempts) {
        const found = findCut(items, total, attempt, protocol, itemBytes, originalBytes, targetBytes);
        if (found === undefined) continue;
        const { cut, droppedBytes } = found;
        const dropped = cut - attempt.headEnd;
        const text = placeholderTextOf(dropped);
        const next: unknown[] = attempt.merge
            ? [...items.slice(0, attempt.headEnd), mergeMarkerInto(items[cut], protocol, text), ...items.slice(cut + 1)]
            : [...items.slice(0, attempt.headEnd), placeholderItem(protocol, attempt.placeholderRole, dropped), ...items.slice(cut)];
        const head = raw.slice(0, span.start);
        const tail = raw.slice(span.end);
        const bodyWith = (value: number | undefined): { body: string; rewritten: boolean } => {
            if (value === undefined) return { body: `${head}${JSON.stringify(next)}${tail}`, rewritten: false };
            const rw = rewriteReplyAllowance(head, tail, value, declared);
            if (rw === undefined) return { body: `${head}${JSON.stringify(next)}${tail}`, rewritten: false };
            return { body: `${rw.head}${JSON.stringify(next)}${rw.tail}`, rewritten: true };
        };
        let outputTokens = declared ?? 0;
        let built = bodyWith(undefined);
        let body = built.body;
        let fittedBytes = Buffer.byteLength(body);
        let fittedTokens = Math.ceil(fittedBytes / 4);
        // Keep the existing fail-open guard: a "fit" that does not actually shrink the
        // body must never be sent.
        if (fittedBytes >= originalBytes) continue;
        const roomForReply = window - fittedTokens - safetyTokens;
        if (roomForReply <= 0) continue;
        const wanted = starved ? wantedReply : (declared ?? 0);
        if (starved || (declared !== undefined && declared > roomForReply)) {
            // Aim at the full allowance first: a blanket safety shave would turn 32,768
            // into 32,760 and make the restored value impossible to pin in a test. Only
            // shave when the rewrite itself (1 -> 32768 lengthens the field) pushes the
            // sum over the window.
            let target = Math.max(1, Math.min(wanted > 0 ? wanted : wantedReply, roomForReply));
            built = bodyWith(target);
            if (!built.rewritten) {
                // Ambiguous envelope: leaving `max_tokens: 1` in place guarantees a
                // truncated checkpoint, which is worse than a shallower cut.
                process.emitWarning(`[compaction-fit] reply allowance could not be rewritten (ambiguous envelope); trying a shallower cut (window ${window}, fitted ~${fittedTokens} tok)`);
                continue;
            }
            fittedTokens = Math.ceil(Buffer.byteLength(built.body) / 4);
            const overflow = fittedTokens + target + safetyTokens - window;
            if (overflow > 0) {
                target = Math.max(1, target - overflow);
                built = bodyWith(target);
                if (!built.rewritten) continue;
                fittedTokens = Math.ceil(Buffer.byteLength(built.body) / 4);
            }
            body = built.body;
            fittedBytes = Buffer.byteLength(body);
            outputTokens = target;
        }
        if (fittedTokens > ceiling * COMPACTION_FIT_TARGET_RATIO) continue;
        if (fittedTokens + outputTokens + safetyTokens > window) continue;
        return {
            body,
            protocol,
            field,
            droppedMessages: dropped,
            keptMessages: total - cut,
            droppedBytes,
            originalBytes,
            fittedBytes,
            originalTokens,
            fittedTokens,
            window,
            budget: Math.max(1, Math.min(ceiling, window - outputTokens)),
            outputTokens,
            placeholder: text,
        };
    }
    return undefined;
}

/** Smallest legal cut for one attempt whose estimated body fits `targetBytes`.
 *  The estimate is conservative: it keeps the ORIGINAL bytes of every kept
 *  item, so a pretty-printed envelope (whose re-serialized tail shrinks) only
 *  ever lands smaller than predicted. */
function findCut(
    items: readonly unknown[],
    total: number,
    attempt: FitAttempt,
    protocol: CompactionWireProtocol,
    itemBytes: readonly number[],
    originalBytes: number,
    targetBytes: number,
): { cut: number; droppedBytes: number } | undefined {
    let droppedBytes = 0;
    for (let cut = attempt.headEnd + 1; cut < total; cut += 1) {
        droppedBytes += itemBytes[cut - 1];
        // Never split a tool call from its result (the kept tail would open
        // with an orphan result): move on to the next boundary.
        if (consumesToolResult(items[cut], protocol)) continue;
        if (attempt.requireStart !== undefined && roleOf(items[cut]) !== attempt.requireStart) continue;
        const dropped = cut - attempt.headEnd;
        const markerBytes = attempt.merge
            ? Buffer.byteLength(placeholderTextOf(dropped)) + 2
            : Buffer.byteLength(JSON.stringify(placeholderItem(protocol, attempt.placeholderRole, dropped))) + 1;
        if (originalBytes - droppedBytes + markerBytes > targetBytes) continue;
        return { cut, droppedBytes };
    }
    return undefined;
}
