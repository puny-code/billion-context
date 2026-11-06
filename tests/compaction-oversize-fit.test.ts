// compaction-fit-oversize: host-native compaction that PROVABLY cannot fit the model's window
// must not be handed to the provider verbatim.
//
// Field failure (before this fix): a 8,650-message session (~1,972,454 tok of
// history) against a 1,048,576-tok model. DSH's auto-compaction replays the
// whole history with its summarization directive; `nativeCompactionPassthrough`
// hands that call back to the host, which sends it straight to the provider:
//
//   compaction/end 400 [invalid_request_error] Input too long: model limit
//   1048576 tokens, requested 1972454 tokens
//   turn/end CONTEXT_WINDOW_EXCEEDED
//
// bili's own proxy cannot fold such a call either — it relays dsh compaction
// calls VERBATIM (src/server/handle.ts: `dsh native compaction — relaying
// verbatim, kernel bypassed`) — so the last place that can act is the client
// hand-back. These cases pin the fitted hand-back (src/agent/compaction-fit.ts)
// and, just as important, that every other dispatch keeps its exact bytes.
//
// Hermetic: XDG_STATE_HOME (the bili.log sink) is redirected so no line can
// reach a real state dir even when the suite is run without the usual
// per-command env isolation.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-cfit-state-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

import { installNativeFetchIntercept, _resetForTest, type NativeInterceptState } from "../src/agent/native-intercept.ts";
import { planCompactionFit, topLevelArraySpanOf } from "../src/agent/compaction-fit.ts";

const DIRECTIVE = "You are now acting as a compaction engine for this AI coding assistant. Summarize the conversation above.";
const TASK = "TASK: ship the API change without breaking callers.";
const WINDOW = 1_048_576;

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Anthropic-shaped compaction envelope whose replayed history is dominated by
 *  one huge tool_result, with a tool pair in the dropped prefix AND a tool pair
 *  in the newest region (so "kept pair stays intact" is a real assertion). */
function anthropicCompactionBody(padChars: number): string {
    return JSON.stringify({
        model: "deepseek-test",
        max_tokens: 8192,
        stream: true,
        system: "you are a coding agent",
        messages: [
            { role: "user", content: TASK },
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_early", name: "read_file", input: { path: "a.ts" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_early", content: "x".repeat(padChars) }] },
            { role: "assistant", content: "the file is large; continuing" },
            { role: "user", content: "recent question" },
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_recent", name: "grep", input: { q: "needle" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_recent", content: "needle found" }] },
            { role: "assistant", content: "found it" },
            { role: "user", content: DIRECTIVE },
        ],
    });
}

interface Sent {
    url: string;
    body: string | undefined;
    headers: Headers;
}

interface Harness {
    sent: Sent[];
    state: NativeInterceptState;
    gateCalls: () => number;
}

async function withIntercept(
    opts: { window?: number | undefined; gate?: boolean; origin?: string | undefined },
    run: (h: Harness) => Promise<void>,
): Promise<void> {
    const saved = globalThis.fetch;
    const sent: Sent[] = [];
    let gateCalls = 0;
    _resetForTest();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        let body: string | undefined;
        const raw: unknown = init?.body;
        if (typeof raw === "string") body = raw;
        else if (raw instanceof Uint8Array) body = new TextDecoder().decode(raw);
        else if (raw === undefined && input instanceof Request) body = await input.clone().text().catch(() => undefined);
        sent.push({
            url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
            body,
            headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
        });
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const origin = opts.origin === undefined ? "http://127.0.0.1:9999" : opts.origin;
    const state: NativeInterceptState = {
        origin,
        ready: Promise.resolve(origin),
        nativeCompactionPassthrough: true,
        declaredWindowForDirect: opts.window === undefined ? () => undefined : () => opts.window,
        takeoverGate: () => {
            gateCalls += 1;
            return opts.gate ?? true;
        },
    };
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        await run({ sent, state, gateCalls: () => gateCalls });
    } finally {
        _resetForTest();
        globalThis.fetch = saved;
    }
}

function messagesOf(body: string, field: "messages" | "input" = "messages"): Rec[] {
    const parsed = JSON.parse(body) as Rec;
    const items = parsed[field];
    assert.ok(Array.isArray(items), `expected ${field}[] in the body`);
    return items as Rec[];
}

/** A tool_result (or bare tool message) may only appear after the tool_use it
 *  answers — the one structural rule a fit can break. */
function assertNoOrphanToolResults(messages: readonly Rec[]): void {
    const produced = new Set<string>();
    for (const message of messages) {
        const content = message.content;
        const blocks = Array.isArray(content) ? content : [];
        for (const block of blocks) {
            if (!isRec(block)) continue;
            if (block.type === "tool_use" && typeof block.id === "string") produced.add(block.id);
        }
        for (const block of blocks) {
            if (!isRec(block)) continue;
            if (block.type !== "tool_result") continue;
            assert.ok(produced.has(String(block.tool_use_id)), `tool_result ${String(block.tool_use_id)} without its tool_use`);
        }
    }
}

function placeholderOf(messages: readonly Rec[]): Rec | undefined {
    return messages.find((m) => typeof m.content === "string" && (m.content as string).startsWith("[billion-context:"));
}

test("compaction-fit: an in-window host compaction call is handed back byte-identically", async () => {
    const body = anthropicCompactionBody(2_000);
    await withIntercept({ window: WINDOW }, async ({ sent }) => {
        const res = await fetch("https://provider.test/v1/messages", { method: "POST", body });
        assert.equal(res.status, 200);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].url, "https://provider.test/v1/messages", "host compaction still goes direct");
        assert.equal(sent[0].body, body, "an in-window compaction body must not be touched");
    });
});

test("compaction-fit: an oversize host compaction call is fitted before the direct send", async () => {
    // ~4 MiB of replayed history: ~1,048,000 tok at bytes/4 — far past the
    // 1,048,576 window once the directive and envelope are counted (the field
    // report was 1,972,454 tok).
    const body = anthropicCompactionBody(4_100_000);
    assert.ok(Buffer.byteLength(body) / 4 > WINDOW * 0.9, "test body must clear the trigger ratio");
    await withIntercept({ window: WINDOW, gate: false }, async ({ sent, gateCalls }) => {
        const res = await fetch("https://provider.test/v1/messages", { method: "POST", body });
        assert.equal(res.status, 200);
        assert.equal(sent.length, 1, "exactly one upstream dispatch");
        const fitted = sent[0].body;
        assert.ok(fitted !== undefined);
        assert.notEqual(fitted, body, "the doomed body must not ride the wire verbatim");
        assert.ok(Buffer.byteLength(fitted) <= WINDOW * 0.8 * 4, "fitted body must fit the window with margin");
        assert.equal(gateCalls(), 0, "the compaction hand-back still precedes the attribution gate (#1117/#2709 semantics)");

        const messages = messagesOf(fitted);
        // JSON is valid (messagesOf parsed it) and every field outside the
        // replayed array is byte-identical.
        const before = topLevelArraySpanOf(body, "messages");
        const after = topLevelArraySpanOf(fitted, "messages");
        assert.ok(before !== undefined && after !== undefined);
        assert.equal(fitted.slice(0, after.start), body.slice(0, before.start), "envelope prefix must be byte-identical");
        assert.equal(fitted.slice(after.end), body.slice(before.end), "envelope suffix must be byte-identical");
        assert.equal((JSON.parse(fitted) as Rec).max_tokens, 8192);
        assert.equal((JSON.parse(fitted) as Rec).stream, true);

        // Opening instruction + newest turns survive; the middle is gone.
        assert.equal(messages[0].content, TASK, "the opening instruction is preserved");
        const placeholder = placeholderOf(messages);
        assert.ok(placeholder !== undefined, "a marked placeholder message must explain the dropped history");
        assert.match(String(placeholder.content), /\[billion-context: the \d+ earlier messages before this point were NOT included in this request/);
        // The rationale has to be an instruction, not a note: this body's only
        // reader is the summarizer, and the count is the one thing that must
        // survive into the summary (everything downstream sees only that).
        assert.match(String(placeholder.content), /State that omission explicitly in the summary you write/);
        assert.equal(messages.at(-1)!.content, DIRECTIVE, "the compaction directive is always last");
        assert.ok(messages.some((m) => JSON.stringify(m).includes("toolu_recent")), "the newest tool pair is kept");
        assert.ok(!messages.some((m) => JSON.stringify(m).includes("toolu_early")), "the oldest tool pair is dropped whole");
        assertNoOrphanToolResults(messages);
    });
});

test("compaction-fit: a Request-object body is probed through a clone and fitted", async () => {
    const body = anthropicCompactionBody(4_100_000);
    await withIntercept({ window: WINDOW }, async ({ sent }) => {
        const request = new Request("https://provider.test/v1/messages", { method: "POST", body });
        await fetch(request);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].url, "https://provider.test/v1/messages");
        assert.ok(Buffer.byteLength(sent[0].body ?? "") < Buffer.byteLength(body), "a Request-carried body is fitted too");
        assert.ok(placeholderOf(messagesOf(sent[0].body ?? "")) !== undefined);
    });
});

test("compaction-fit: a healthy attribution gate does not divert the compaction hand-back", async () => {
    const body = anthropicCompactionBody(4_100_000);
    await withIntercept({ window: WINDOW, gate: true }, async ({ sent }) => {
        await fetch("http://127.0.0.1:9999/bili/https://provider.test/v1/messages", { method: "POST", body });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].url, "https://provider.test/v1/messages", "hand-back precedes takeover: no proxy rewrite");
        assert.ok(Buffer.byteLength(sent[0].body ?? "") < Buffer.byteLength(body), "still fitted");
    });
});

test("compaction-fit: an unknown window keeps today's behavior (verbatim hand-back)", async () => {
    const body = anthropicCompactionBody(4_100_000);
    await withIntercept({ window: undefined }, async ({ sent }) => {
        await fetch("https://provider.test/v1/messages", { method: "POST", body });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].body, body, "no window declared → never truncate");
    });
});

test("compaction-fit: a non-compaction oversize body is untouched (no false fits)", async () => {
    const body = JSON.stringify({
        model: "deepseek-test",
        messages: [
            { role: "user", content: "x".repeat(4_200_000) },
        ],
    });
    await withIntercept({ window: WINDOW }, async ({ sent }) => {
        await fetch("https://provider.test/v1/messages", { method: "POST", body });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].body, body, "only host compaction calls are fitted");
    });
});

test("planCompactionFit: a tool pair straddling the cut is dropped whole, never split", () => {
    // The huge history sits BEHIND the tool pair, so the smallest shrinking cut
    // is the tool_result that answers it — the fit must move past that boundary
    // (one more message dropped) instead of opening the kept tail on an orphan
    // result.
    const body = JSON.stringify({
        model: "deepseek-test",
        messages: [
            { role: "user", content: TASK },
            { role: "assistant", content: "thinking" },
            { role: "user", content: "y".repeat(20_000) },
            { role: "assistant", content: [{ type: "tool_use", id: "toolu_mid", name: "read_file", input: { path: "b.ts" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mid", content: "ok" }] },
            { role: "assistant", content: "done" },
            { role: "user", content: DIRECTIVE },
        ],
    });
    const plan = planCompactionFit(body, 400);
    assert.ok(plan !== undefined);
    const messages = messagesOf(plan.body);
    assertNoOrphanToolResults(messages);
    assert.ok(!messages.some((m) => JSON.stringify(m).includes("toolu_mid")), "the straddling pair is dropped whole");
    assert.equal(messages[0].content, TASK, "the opening instruction survives");
    assert.equal(messages.at(-1)!.content, DIRECTIVE);
});

test("planCompactionFit: only the replayed array changes, even in a pretty-printed envelope", () => {
    const envelope = {
        model: "deepseek-test",
        max_tokens: 512,
        stream: true,
        tools: [{ name: "read_file" }],
        messages: [
            { role: "user", content: TASK },
            { role: "assistant", content: "z".repeat(20_000) },
            { role: "assistant", content: "newest" },
            { role: "user", content: DIRECTIVE },
        ],
    };
    const pretty = JSON.stringify(envelope, null, 2);
    const plan = planCompactionFit(pretty, 5_000);
    assert.ok(plan !== undefined);
    const before = topLevelArraySpanOf(pretty, "messages");
    const after = topLevelArraySpanOf(plan.body, "messages");
    assert.ok(before !== undefined && after !== undefined);
    assert.equal(plan.body.slice(0, after.start), pretty.slice(0, before.start));
    assert.equal(plan.body.slice(after.end), pretty.slice(before.end));
    // and the non-array content really is intact, formatting included
    assert.ok(plan.body.includes('\n  "tools": [\n'), "pretty-printed tools survive byte-for-byte");
    const parsed = JSON.parse(plan.body) as Rec;
    assert.equal(parsed.max_tokens, 512);
    assert.deepEqual(parsed.tools, envelope.tools);
});

test("planCompactionFit: responses wire fits `input` with a typed placeholder", () => {
    const body = JSON.stringify({
        model: "deepseek-test",
        input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: TASK }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "w".repeat(20_000) }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "newest" }] },
            { type: "message", role: "user", content: [{ type: "input_text", text: DIRECTIVE }] },
        ],
    });
    const plan = planCompactionFit(body, 5_000);
    assert.ok(plan !== undefined);
    assert.equal(plan.field, "input");
    const items = messagesOf(plan.body, "input");
    const placeholder = items.find((item) => JSON.stringify(item).includes("[billion-context:"));
    assert.ok(placeholder !== undefined);
    assert.equal(placeholder.type, "message");
    assert.ok(Array.isArray(placeholder.content));
    assert.equal((placeholder.content as Rec[])[0].type, "input_text");
    assert.deepEqual(messagesOf(plan.body, "input").at(-1), { type: "message", role: "user", content: [{ type: "input_text", text: DIRECTIVE }] });
});

/** A replay whose kept TAIL is itself large: a 100 KB early tool result plus
 *  four assistant/user pairs of `tailChars`. */
function mixedHistoryBody(padChars: number, tailChars: number, maxTokens: number): string {
    const items: Rec[] = [
        { role: "user", content: TASK },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_pad", name: "read_file", input: { path: "big.ts" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_pad", content: "p".repeat(padChars) }] },
    ];
    for (let k = 0; k < 4; k += 1) {
        items.push({ role: "assistant", content: "a".repeat(tailChars) });
        items.push({ role: "user", content: k === 3 ? DIRECTIVE : "u".repeat(tailChars) });
    }
    return JSON.stringify({ model: "deepseek-test", max_tokens: maxTokens, stream: true, system: "you are a coding agent", messages: items });
}

test("planCompactionFit: budgets the fit against window minus the declared reply allowance", () => {
    const window = 100_000;
    const plan = planCompactionFit(mixedHistoryBody(100_000, 50_000, 25_000), window);
    assert.ok(plan !== undefined, "an oversize replay is fitted");
    // The provider caps input+output at the window, so asking for 25,000 output
    // tokens leaves a 75,000 input ceiling — and the target is 80% of THAT.
    // Live evidence: a 27.4 MB replay was fitted to ~830,803 tok against the
    // 1,048,576 window and the provider still answered "Input too long", because
    // the request declared max_tokens 256,000 and the ceiling was 792,576.
    assert.equal(plan.budget, 75_000);
    assert.ok(plan.fittedTokens <= 60_000, `fitted ${plan.fittedTokens} tok exceeds the 80% target`);
    assert.ok(plan.droppedMessages > 0);
    const kept = messagesOf(plan.body);
    assert.equal(kept.at(-1)?.content, DIRECTIVE);
    assertNoOrphanToolResults(kept);
});

test("planCompactionFit: a modest reply allowance leaves the window essentially intact", () => {
    const window = 100_000;
    const plan = planCompactionFit(mixedHistoryBody(100_000, 50_000, 8_192), window);
    assert.ok(plan !== undefined);
    assert.equal(plan.budget, 91_808, "only the 8,192-token reply is held back");
    assert.ok(plan.fittedTokens <= Math.floor(91_808 * 0.8));
});

test("planCompactionFit: declines every shape it cannot reason about", () => {
    const small = anthropicCompactionBody(1_000);
    assert.equal(planCompactionFit(small, WINDOW), undefined, "in-window");
    assert.equal(planCompactionFit(anthropicCompactionBody(4_100_000), undefined), undefined, "window unknown");
    const notCompaction = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(4_100_000) }] });
    assert.equal(planCompactionFit(notCompaction, WINDOW), undefined, "not a compaction call");
    assert.equal(planCompactionFit("{not json", WINDOW), undefined, "undecodable body");
});
