// A compaction request whose reply allowance was clamped to ~1 token cannot
// produce a checkpoint: the provider answers 200 and writes one token, the host
// reads that as `summarization truncated at the token cap (incomplete
// checkpoint)` and throws the checkpoint away. These cases pin the restore, and
// pin that a healthy or deliberately small allowance is never touched.
import test from "node:test";
import assert from "node:assert/strict";

// These cases exercise pure functions only — no store, no state dir. Do NOT set
// XDG_STATE_HOME here: ESM hoists static imports above any assignment, so an
// in-file assignment would run after the module under test has loaded.

import {
    COMPACTION_FIT_RESTORED_OUTPUT_TOKENS,
    planCompactionFit,
    rewriteReplyAllowance,
} from "../src/agent/compaction-fit.ts";

const DIRECTIVE = "You are now acting as a compaction engine for this AI coding assistant. Summarize the conversation above.";
const TASK = "TASK: ship the API change without breaking callers.";

type Rec = Record<string, unknown>;

/** Anthropic-shaped replay: `pairs` user+assistant exchanges of `padChars` each.
 *  Alternating roles matter — a fixture of assistant-only turns gives the cut
 *  finder exactly one legal boundary, so every case collapses to a 682-byte
 *  body and proves nothing about a real replay. */
function anthropicBody(maxTokens: number | undefined, pairs = 40, padChars = 40_000): string {
    const messages: Rec[] = [{ role: "user", content: TASK }];
    for (let i = 0; i < pairs; i += 1) {
        messages.push({ role: "user", content: "u".repeat(padChars) });
        messages.push({ role: "assistant", content: "a".repeat(padChars) });
    }
    messages.push({ role: "user", content: DIRECTIVE });
    const envelope: Rec = { model: "deepseek-test", stream: true, system: "you are a coding agent", messages };
    if (maxTokens !== undefined) envelope.max_tokens = maxTokens;
    return JSON.stringify(envelope);
}

test("starved allowance (max_tokens: 1) is restored and the input budget shrinks with it", () => {
    const plan = planCompactionFit(anthropicBody(1), 100_000);
    assert.ok(plan, "the body is over the window and must be fitted");
    assert.equal(plan.outputTokens, COMPACTION_FIT_RESTORED_OUTPUT_TOKENS);
    assert.equal((JSON.parse(plan.body) as Rec).max_tokens, COMPACTION_FIT_RESTORED_OUTPUT_TOKENS);
    // One budget, not two: input + output must fit the window.
    assert.ok(plan.fittedTokens + plan.outputTokens <= plan.window,
        `fitted ${plan.fittedTokens} + output ${plan.outputTokens} must stay under ${plan.window}`);
    const messages = (JSON.parse(plan.body) as { messages: Rec[] }).messages;
    assert.equal(messages[0].content, TASK, "the opening instruction survives");
    assert.equal(messages.at(-1)!.content, DIRECTIVE, "the directive survives");
    assert.ok(plan.droppedMessages > 0, "history was dropped for size");
});

test("a healthy allowance is never touched", () => {
    const plan = planCompactionFit(anthropicBody(8192), 100_000);
    assert.ok(plan);
    assert.equal(plan.outputTokens, 8192);
    assert.equal((JSON.parse(plan.body) as Rec).max_tokens, 8192);
});

test("a deliberately small allowance (512) is not a collapse signature", () => {
    const plan = planCompactionFit(anthropicBody(512), 100_000);
    assert.ok(plan);
    assert.equal(plan.outputTokens, 512);
    assert.equal((JSON.parse(plan.body) as Rec).max_tokens, 512);
});

test("an allowance larger than the window leaves room for is reduced", () => {
    // 65,536 on a 100k window would make input + output exceed the window even
    // after the fit; the body must be rewritten DOWN, not left as asked.
    const plan = planCompactionFit(anthropicBody(65_536), 100_000);
    assert.ok(plan);
    assert.ok(plan.outputTokens < 65_536, "the declared allowance was reduced");
    assert.equal((JSON.parse(plan.body) as Rec).max_tokens, plan.outputTokens);
    assert.ok(plan.fittedTokens + plan.outputTokens <= plan.window);
});

test("an absent allowance stays absent — the fit does not invent a field", () => {
    const plan = planCompactionFit(anthropicBody(undefined), 100_000);
    assert.ok(plan);
    assert.equal((JSON.parse(plan.body) as Rec).max_tokens, undefined);
    assert.equal(plan.outputTokens, 0);
});

test("a bigger replay still lands inside the window (scale is not a parameter)", () => {
    // 120 user/assistant pairs × 40k chars ≈ 9.6 MB — the shape of a real runaway
    // session, three times the previous case.
    const plan = planCompactionFit(anthropicBody(1, 120, 40_000), 200_000);
    assert.ok(plan);
    assert.ok(plan.fittedTokens + plan.outputTokens <= plan.window);
    assert.ok(plan.droppedMessages >= 100, `dropped ${plan.droppedMessages} earlier messages`);
});

test("rewriteReplyAllowance refuses an ambiguous envelope instead of guessing", () => {
    // A nested object that also declares a NUMERIC `max_tokens` makes two
    // occurrences: the real allowance and the nested one. Must not guess.
    // (A schema entry like `"max_tokens":{"type":"number"}` would NOT match —
    // the regex needs a digit after the colon, so it only produces one hit.)
    const head = '{"model":"m","max_tokens":1,"metadata":{"max_tokens":1},';
    const tail = "}";
    assert.equal(rewriteReplyAllowance(head, tail, 32768, 1), undefined);
});

test("a small window never overruns after the allowance is rewritten", () => {
    // 8k window: rewriting `max_tokens` lengthens the field by a few bytes. An
    // implementation that measures only after the rewrite drops this cut and
    // sends the request verbatim — a guaranteed 400.
    const plan = planCompactionFit(anthropicBody(1, 20, 1_000), 8_192);
    assert.ok(plan, "a starved allowance on a small window still has to fit");
    assert.ok(plan.fittedTokens + plan.outputTokens + 2_048 <= 8_192,
        `fitted ${plan.fittedTokens} + output ${plan.outputTokens} + 2048 must stay under 8192`);
    assert.ok(plan.outputTokens >= 1);
});

test("an ambiguous envelope never ships max_tokens: 1", () => {
    // Two numeric occurrences (the real allowance and a nested one): the rewrite
    // refuses to guess, so the cut must be dropped rather than sent with the
    // 1-token clamp still in it.
    const head = '{"model":"m","max_tokens":1,"metadata":{"max_tokens":1},';
    const msgs = [
        { role: "user", content: "u".repeat(40_000) },
        { role: "assistant", content: "a".repeat(40_000) },
        { role: "user", content: DIRECTIVE },
    ];
    const plan = planCompactionFit(`${head}"messages":${JSON.stringify(msgs)}}`, 100_000);
    if (plan !== undefined) {
        assert.notEqual((JSON.parse(plan.body) as Rec).max_tokens, 1, "a 1-token plan must never be sent");
    }
});
test("rewriteReplyAllowance rewrites exactly one scalar and leaves every other byte", () => {
    const head = '{\n  "model": "m",\n  "max_tokens": 1,\n  "system": "s",';
    const tail = "\n}";
    const out = rewriteReplyAllowance(head, tail, 32768, 1);
    assert.ok(out);
    assert.equal(out.head, '{\n  "model": "m",\n  "max_tokens": 32768,\n  "system": "s",');
    assert.equal(out.tail, tail);
});

test("the same restore works on the openai and responses wires", () => {
    const openai = JSON.stringify({
        model: "m", max_tokens: 1, stream: true,
        messages: [
            { role: "user", content: TASK },
            ...Array.from({ length: 40 }, () => ({ role: "assistant", content: "x".repeat(40_000) })),
            { role: "user", content: DIRECTIVE },
        ],
    });
    const openaiPlan = planCompactionFit(openai, 100_000);
    assert.ok(openaiPlan);
    assert.equal(openaiPlan.outputTokens, COMPACTION_FIT_RESTORED_OUTPUT_TOKENS);

    const responses = JSON.stringify({
        model: "m", max_output_tokens: 1, stream: true,
        input: [
            { role: "user", content: [{ type: "input_text", text: TASK }] },
            ...Array.from({ length: 40 }, () => ({ role: "assistant", content: [{ type: "output_text", text: "x".repeat(40_000) }] })),
            { role: "user", content: [{ type: "input_text", text: DIRECTIVE }] },
        ],
    });
    const responsesPlan = planCompactionFit(responses, 100_000);
    assert.ok(responsesPlan);
    assert.equal(responsesPlan.outputTokens, COMPACTION_FIT_RESTORED_OUTPUT_TOKENS);
    assert.equal((JSON.parse(responsesPlan.body) as Rec).max_output_tokens, COMPACTION_FIT_RESTORED_OUTPUT_TOKENS);
});
