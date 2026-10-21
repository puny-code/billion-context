// F2 (#identity): the request path used to keep only the resolver's key, so a
// `reanchor` (the compression anchor moves) or an order/persona fork (a fresh
// lane with zero blocks) was INVISIBLE in bili.log. That is the shape of the
// 2026-10-21 brick: the main lane's 86 blocks stayed under `|sub:<fp>` while
// the request path re-claimed the empty raw record, and no line said so.
//
// This suite pins the log surface, not the resolver (the resolver's own
// contracts live in issue2944-*/issue2601-*/issue3397-* suites):
//   - routine claim/continue never log (no per-request noise),
//   - the one-blob reviewer probes dsh fires before every tool call never log
//     (they fork by design, #1916/#1307),
//   - a main conversation's reanchor/fork DOES log, and the line carries the
//     raw id, the resulting key, the action and the resolver's reason.
//
// NEGATIVE halves are first-class here: a diagnostic that fires on every
// request is unreadable, and one that stays silent on the incident shape would
// have let it happen again.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Hermetic state dirs BEFORE importing the server modules (same idiom as
// tests/issue2601-model-drift-absorption.test.ts — the prefix-affinity
// snapshot otherwise persists across runs).
const testRoot = mkdtempSync(path.join(tmpdir(), "bc-identity-note-"));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const { personaConversationResolution, personaConversationOrder, identityDecisionNote, resetSessionOrderForTest, IDENTITY_NOTE_MIN_CELLS } =
    await import("../src/session-resolve.ts");

test.after(() => rmSync(testRoot, { recursive: true, force: true }));

const SYSTEM_A = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-4.6.\nWorkspace: /tmp.";
const REVIEW_SYSTEM = "You are the final authorization reviewer for exactly one pending tool call.\nAnswer with one word.";

const msgs = (n: number, tag: string): { role: string; content: string }[] =>
    Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `${tag}-${i + 1}-` + "z".repeat(120),
    }));

test.beforeEach(() => resetSessionOrderForTest());

test("a fresh id claims the raw key and logs nothing", () => {
    const raw = "conv-claim";
    const resolution = personaConversationResolution(raw, msgs(40, "a"), SYSTEM_A, "glm-4.6");
    assert.equal(resolution.action, "claim");
    assert.equal(resolution.key, raw);
    // NEGATIVE: the ordinary path must stay silent — no line per request.
    assert.equal(identityDecisionNote(raw, resolution, 40), null);
});

test("a continuing conversation logs nothing", () => {
    const raw = "conv-continue";
    personaConversationResolution(raw, msgs(40, "a"), SYSTEM_A, "glm-4.6");
    const second = personaConversationResolution(raw, msgs(40, "a"), SYSTEM_A, "glm-4.6");
    assert.equal(second.action, "continue");
    assert.equal(identityDecisionNote(raw, second, 40), null);
});

test("a one-blob reviewer probe forks but stays silent (it forks by design)", () => {
    const raw = "conv-review";
    personaConversationResolution(raw, msgs(40, "main"), SYSTEM_A, "glm-4.6");
    // dsh auto-review before a tool call: a single flattened user blob with a
    // fixed review system text, under the SAME conversation id.
    const review = personaConversationResolution(raw, msgs(1, "review"), REVIEW_SYSTEM, "glm-4.6");
    assert.notEqual(review.key, raw);
    assert.notEqual(review.action, "claim");
    assert.equal(identityDecisionNote(raw, review, 1), null);
});

test("the noise floor is exactly IDENTITY_NOTE_MIN_CELLS", () => {
    for (const action of ["reanchor", "derived-persona", "derived-task", "derived-aux"] as const) {
        const resolution = { key: "conv|sub:abc", action, reason: "r" };
        // NEGATIVE half: one cell below the floor is a probe, not a main lane.
        assert.equal(identityDecisionNote("conv", resolution, IDENTITY_NOTE_MIN_CELLS - 1), null);
        // POSITIVE half: at the floor the decision is worth a line.
        const note = identityDecisionNote("conv", resolution, IDENTITY_NOTE_MIN_CELLS);
        assert.notEqual(note, null);
        assert.ok(note!.includes(`action=${action}`));
    }
    // A non-finite cell count (defensive: the history was not an array) must
    // not produce a line either.
    assert.equal(identityDecisionNote("conv", { key: "x", action: "reanchor" }, Number.NaN), null);
});

test("a reanchor on a main-shaped history logs the raw key and action", () => {
    const raw = "conv-reanchor";
    const full = msgs(40, "a");
    personaConversationResolution(raw, full, SYSTEM_A, "glm-4.6");
    // Head truncation: the tail stays verbatim (dsh-native-compaction shape).
    const truncated = full.slice(20);
    const resolution = personaConversationResolution(raw, truncated, SYSTEM_A, "glm-4.6");
    assert.equal(resolution.action, "reanchor", "the resolver must report the reanchor this note exists to surface");
    const note = identityDecisionNote(raw, resolution, truncated.length);
    assert.notEqual(note, null);
    assert.ok(note!.includes("action=reanchor"), note!);
    assert.ok(note!.includes(`raw=${raw}`), note!);
    assert.ok(note!.includes(`key=${raw}`), note!);
    assert.ok(note!.includes("cells=20"), note!);
});

test("a main-lane fork logs the lane switch and the resolver's reason", () => {
    const raw = "conv-fork";
    personaConversationResolution(raw, msgs(40, "main"), SYSTEM_A, "glm-4.6");
    // A different persona over a history that shares no order/fragment
    // alignment, with the SAME declared model (a model switch alone is
    // absorbed onto the raw key by #2601 — see the next test): the resolver
    // derives a fork lane.
    const fork = personaConversationResolution(raw, msgs(30, "other"), REVIEW_SYSTEM, "glm-4.6");
    assert.notEqual(fork.key, raw, "the resolver must report the fork this note exists to surface");
    const note = identityDecisionNote(raw, fork, 30);
    assert.notEqual(note, null);
    assert.ok(note!.includes(`key=${fork.key}`), note!);
    assert.ok(note!.includes("reason="), note!);
});

test("a model switch migrates the anchor and logs action=reanchor", () => {
    const raw = "conv-modelswitch";
    personaConversationResolution(raw, msgs(40, "main"), SYSTEM_A, "glm-4.6");
    // #2601: the persona text and the declared model change together while the
    // conversation continues — the anchor MIGRATES on the raw key instead of
    // forking. That migration moves the compression anchor, which is exactly
    // the class of decision that must be visible.
    const switched = personaConversationResolution(raw, msgs(40, "main"), REVIEW_SYSTEM, "glm-5.3");
    assert.equal(switched.key, raw);
    assert.equal(switched.action, "reanchor");
    const note = identityDecisionNote(raw, switched, 40);
    assert.notEqual(note, null);
    assert.ok(note!.includes("action=reanchor"), note!);
    assert.ok(note!.includes("reason="), note!);
});

test("the note-less fast path returns the same key as the full-resolution path", () => {
    const raw = "conv-parity";
    const history = msgs(40, "a");
    const viaOrder = personaConversationOrder(raw, history, SYSTEM_A, "glm-4.6");
    assert.equal(viaOrder, raw);
    // Parity on the fork shape too — the wiring swap must not change identity.
    resetSessionOrderForTest();
    personaConversationResolution(raw, msgs(40, "main"), SYSTEM_A, "glm-4.6");
    const fork = personaConversationResolution(raw, msgs(30, "other"), REVIEW_SYSTEM, "glm-4.6");
    assert.equal(personaConversationOrder(raw, msgs(30, "other"), REVIEW_SYSTEM, "glm-4.6"), fork.key);
});
