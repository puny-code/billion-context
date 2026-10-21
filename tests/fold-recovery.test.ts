import test from "node:test";
import assert from "node:assert/strict";
import {
    conversationOf,
    foldRecoveryConflict,
    foldRecoveryGate,
    mergeAdoptedContentStore,
    pickFoldDonor,
    recoverFoldsFromSibling,
    siblingLaneIds,
    type FoldRecoveryDeps,
    type ForkAdoptionPlan,
} from "../src/fork-adoption.ts";
import type { MessageContentStore } from "acp-kernel";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { Session } from "../src/session.ts";

/**
 * #4046 lane-level fold recovery. Incident shape this pins: the resolver keys
 * state by conversation id + a `|sub:` persona/fork fingerprint, so a model or
 * system-prompt change forks a NEW lane with zero fold state. Switching back
 * re-enters the RAW lane, whose on-disk record was a refs-only husk (15 refs,
 * 0 blocks) while the sibling `|sub:` lane still held 86 folded blocks. The
 * client then replayed 1.29M tokens into a 1M window and every message 400'd.
 *
 * The recovery adopts the sibling's blocks (content-addressed ids make that
 * exact, not heuristic). These cases pin the gates: it must not fire on a lane
 * that still owns active blocks, must not cross conversations, must not adopt a
 * sibling whose blocks the replay does not fully contain, and must not treat an
 * all-inactive ledger as a donor. Every case asserts a NEGATIVE as well, so a
 * mutation that always adopts (or never adopts) fails here.
 */

// markDirty() → getStore().scheduleSave: a disabled store keeps the unit test
// off the disk without stubbing session.js.
_setStoreForTest(new SessionStore({ enabled: false }));

type BlockSpec = { id: string; rawIds: string[]; tokens: number; active?: boolean };

function fakeSession(id: string, blocks: BlockSpec[], raws: string[]): Session {
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    raws.forEach((raw, i) => {
        const ref = `m${String(i + 1).padStart(5, "0")}`;
        byRaw[raw] = ref;
        byRef[ref] = raw;
    });
    const tokenSnapshot: Record<string, number> = {};
    for (const ref of Object.values(byRaw)) tokenSnapshot[ref] = 100;
    const blockContents = new Map<string, unknown>();
    const blockRecords = blocks.map((b) => {
        blockContents.set(b.id, { one: `summary ${b.id}`, full: [`summary ${b.id}`] });
        return {
            blockId: b.id,
            active: b.active ?? true,
            effectiveMessageIds: b.rawIds,
            directBlockIds: [] as string[],
            compressedTokens: b.tokens,
        };
    });
    const session = {
        id,
        meta: {},
        stats: { requests: 5 },
        metadata: {} as Record<string, unknown>,
        state: {
            blocks: blockRecords,
            messageRefs: { byRaw, byRef },
            tokenSnapshot,
            nextBlockId: blockRecords.length + 1,
            nextRunId: 1,
            nudge: {},
            stats: { compressionCount: blockRecords.length },
        },
        blockContents,
    };
    return session as unknown as Session;
}

function depsOf(sessions: Record<string, Session>, loads?: string[]): FoldRecoveryDeps {
    return {
        knownSessionIds: () => Object.keys(sessions),
        loadSession: (id) => {
            loads?.push(id);
            return sessions[id] ?? null;
        },
        peek: () => undefined,
    };
}

function logger(): { log: (level: string, msg: string) => void; lines: string[] } {
    const lines: string[] = [];
    return { log: (level, msg) => lines.push(`${level} ${msg}`), lines };
}

test("#4046 conversationOf splits on the resolver suffix only", () => {
    assert.equal(conversationOf("session-abc"), "session-abc");
    assert.equal(conversationOf("session-abc|sub:919f2f1b4676a9ad"), "session-abc");
    assert.equal(conversationOf("session-abc|sub:task:1234abcd"), "session-abc");
    // A pipe at position 0 is not a lane separator (never minted by us) — the
    // id is kept whole rather than becoming an empty conversation.
    assert.equal(conversationOf("|sub:x"), "|sub:x");
});

test("#4046 siblingLaneIds keeps same-conversation lanes and never the raw lane", () => {
    const known = [
        "conv-a",
        "conv-a|sub:aaaaaaaaaaaaaaaa",
        "conv-a|sub:bbbbbbbbbbbbbbbb",
        "conv-b|sub:cccccccccccccccc",
        "conv-ab|sub:dddddddddddddddd",
    ];
    assert.deepEqual(siblingLaneIds(known, "conv-a"), ["conv-a|sub:aaaaaaaaaaaaaaaa", "conv-a|sub:bbbbbbbbbbbbbbbb"]);
    // The RAW lane is not a sibling of its own sub-lane.
    assert.deepEqual(siblingLaneIds(known, "conv-a|sub:aaaaaaaaaaaaaaaa"), ["conv-a|sub:bbbbbbbbbbbbbbbb"]);
    // Prefix sharing is not identity: conv-ab is a different conversation.
    assert.deepEqual(siblingLaneIds(known, "conv-a|sub:zzzzzzzzzzzzzzzz"), ["conv-a|sub:aaaaaaaaaaaaaaaa", "conv-a|sub:bbbbbbbbbbbbbbbb"]);
});

test("#4046 siblingLaneIds drops task-skeleton lanes and orders persona lanes first", () => {
    // A `|sub:task:` lane carries extracted memory, never a conversation
    // transcript: its blocks can not cover a replay's refs, so it must not
    // consume a donor slot (and a pathological tree can mint many of them).
    const known = [
        "conv-a",
        "conv-a|sub:bbbbbbbbbbbbbbbb",
        "conv-a|sub:task:dddddddd",
        "conv-a|sub:aaaaaaaaaaaaaaaa",
        "conv-a|other",
    ];
    assert.deepEqual(siblingLaneIds(known, "conv-a"), [
        "conv-a|sub:aaaaaaaaaaaaaaaa",
        "conv-a|sub:bbbbbbbbbbbbbbbb",
        "conv-a|other",
    ]);
    // Order is deterministic: the store's enumeration order is not, and a
    // donor-budget cap that depended on it would be a coin flip.
    assert.deepEqual(siblingLaneIds([...known].reverse(), "conv-a"), siblingLaneIds(known, "conv-a"));
});

test("#4046 pickFoldDonor prefers the most folded history, then the larger fold", () => {
    const plan = (adoptedActive: number, adoptedTokens: number) => ({ plan: { adoptedActive, adoptedTokens } });
    assert.equal(pickFoldDonor([]), null);
    const only = plan(1, 900);
    assert.equal(pickFoldDonor([only]), only, "a single candidate is returned as-is");
    assert.equal(pickFoldDonor([plan(1, 900), plan(3, 500), plan(3, 4000)])!.plan.adoptedTokens, 4000);
    assert.equal(pickFoldDonor([plan(1, 900), plan(2, 100)])!.plan.adoptedActive, 2);
});

test("#4046 recovery adopts the sibling ledger for a replay that contains it", () => {
    // The husk: a lane with refs but no blocks, exactly the incident's shape.
    const lane = fakeSession("conv-a", [], []);
    const donor = fakeSession("conv-a|sub:919f2f1b4676a9ad", [
        { id: "b1", rawIds: ["raw1", "raw2"], tokens: 900 },
        { id: "b2", rawIds: ["raw3"], tokens: 400 },
    ], ["raw1", "raw2", "raw3"]);
    const { log, lines } = logger();
    const result = recoverFoldsFromSibling({
        session: lane,
        incomingIds: new Set(["raw1", "raw2", "raw3", "raw4"]),
        deps: depsOf({ "conv-a": lane, "conv-a|sub:919f2f1b4676a9ad": donor }),
        log,
    });
    assert.equal(result.adopted, 2);
    assert.equal(result.donorId, "conv-a|sub:919f2f1b4676a9ad");
    assert.equal(result.scanned, 1);
    assert.equal(lane.state.blocks.filter((b) => b.active).length, 2);
    assert.equal(lane.blockContents.size, 2, "the summaries must come along, not just the block records");
    assert.equal(lane.metadata.foldRecoveredFrom, "conv-a|sub:919f2f1b4676a9ad");
    assert.ok(lines.some((l) => l.startsWith("info [fold-recovery]")), "an adoption must be announced");
});

test("#4046 recovery stays out of the way when the lane still owns active blocks", () => {
    const healthy = fakeSession("conv-a", [{ id: "own", rawIds: ["raw1"], tokens: 10 }], ["raw1"]);
    const donor = fakeSession("conv-a|sub:919f2f1b4676a9ad", [{ id: "b1", rawIds: ["raw1"], tokens: 900 }], ["raw1"]);
    const loads: string[] = [];
    const { log } = logger();
    const result = recoverFoldsFromSibling({
        session: healthy,
        incomingIds: new Set(["raw1"]),
        deps: depsOf({ "conv-a": healthy, "conv-a|sub:919f2f1b4676a9ad": donor }, loads),
        log,
    });
    assert.equal(result.adopted, 0);
    assert.equal(result.donorId, null);
    assert.deepEqual(loads, [], "no donor may be loaded for a lane that kept its ledger");
    assert.equal(healthy.state.blocks.length, 1);
});

test("#4046 recovery refuses a donor whose blocks are only partly replayed", () => {
    const lane = fakeSession("conv-a", [], []);
    // b1 covers raw1, which the replay no longer contains (the client moved on
    // and the fold straddles it) — adopting it would drop live messages.
    const donor = fakeSession("conv-a|sub:deadbeefdeadbeef", [{ id: "b1", rawIds: ["raw1", "gone"], tokens: 900 }], ["raw1"]);
    const { log, lines } = logger();
    const result = recoverFoldsFromSibling({
        session: lane,
        incomingIds: new Set(["raw1", "raw2"]),
        deps: depsOf({ "conv-a": lane, "conv-a|sub:deadbeefdeadbeef": donor }),
        log,
    });
    assert.equal(result.adopted, 0);
    assert.equal(lane.state.blocks.length, 0);
    assert.ok(lines.some((l) => l.includes("folding from scratch")), "a miss must be visible in the log");
});

test("#4046 recovery skips all-inactive ledgers and other conversations", () => {
    const lane = fakeSession("conv-a", [], []);
    const inactive = fakeSession("conv-a|sub:inactive0000000", [
        { id: "b1", rawIds: ["raw1"], tokens: 900, active: false },
    ], ["raw1"]);
    const foreign = fakeSession("conv-b|sub:ffffffffffffffff", [{ id: "b1", rawIds: ["raw1"], tokens: 900 }], ["raw1"]);
    const loads: string[] = [];
    const { log } = logger();
    const result = recoverFoldsFromSibling({
        session: lane,
        incomingIds: new Set(["raw1"]),
        deps: depsOf(
            { "conv-a": lane, "conv-a|sub:inactive0000000": inactive, "conv-b|sub:ffffffffffffffff": foreign },
            loads,
        ),
        log,
    });
    assert.equal(result.adopted, 0);
    assert.deepEqual(loads, ["conv-a|sub:inactive0000000"], "only same-conversation lanes may be read");
    assert.equal(lane.state.blocks.length, 0);
});

test("#4046 recovery refuses a donor whose ref numbering disagrees with the lane", () => {
    // The incident husk was refs-only (15 refs), not empty: it had already bound
    // its first messages to numbers. The kernel's assignRefs never re-numbers an
    // existing mapping, so adopting a plan that binds an occupied number to a
    // DIFFERENT message would make compress/decompress act on the wrong live
    // message — worse than the lost ledger. All-or-nothing: refuse, don't
    // "mostly adopt".
    const lane = fakeSession("conv-a", [], ["raw1"]);
    const donor = fakeSession("conv-a|sub:919f2f1b4676a9ad", [{ id: "b1", rawIds: ["raw2"], tokens: 900 }], []);
    donor.state.messageRefs.byRaw = { raw2: "m00001" };
    donor.state.messageRefs.byRef = { m00001: "raw2" };
    const { log, lines } = logger();
    const result = recoverFoldsFromSibling({
        session: lane,
        incomingIds: new Set(["raw1", "raw2"]),
        deps: depsOf({ "conv-a": lane, "conv-a|sub:919f2f1b4676a9ad": donor }),
        log,
    });
    assert.equal(result.adopted, 0);
    assert.equal(result.donorId, null);
    assert.equal(lane.state.blocks.length, 0, "a refused adoption must not be partial");
    assert.deepEqual(lane.state.messageRefs.byRaw, { raw1: "m00001" }, "the lane's ref space is untouched");
    assert.equal(lane.state.messageRefs.byRef.m00001, "raw1");
    assert.ok(lines.some((l) => l.includes("ref-space safety")), "the refusal must be logged with its reason");
});

test("#4046 foldRecoveryConflict names the collision and clears a compatible plan", () => {
    const lane = fakeSession("conv-a", [], ["raw1", "raw2"]);
    // Same numbering for the messages both lanes know: adoptable (this is the
    // real incident shape — both lanes derive refs from the same transcript).
    const agreeing: ForkAdoptionPlan = {
        blocks: [],
        blockIds: new Set<string>(),
        adoptedActive: 1,
        adoptedTokens: 100,
        straddled: 0,
        maxRef: "m00002",
        refs: { byRaw: { raw1: "m00001", raw2: "m00002" }, byRef: { m00001: "raw1", m00002: "raw2" } },
        tokenSnapshot: {},
        nextBlockId: 1,
        nextRunId: 1,
    };
    assert.equal(foldRecoveryConflict(lane, agreeing), null);
    // And the ref disagreement is reported with both numbers.
    const refClash: ForkAdoptionPlan = { ...agreeing, refs: { byRaw: { raw1: "m00009" }, byRef: { m00009: "raw1" } } };
    assert.match(String(foldRecoveryConflict(lane, refClash)), /m00001/);
});

test("#4046 recovery refuses a donor whose block id the lane already owns", () => {
    // The husk kept an inactive block record while the donor carries a block of
    // the same id: adopting would push a duplicate id into one lane (and
    // overwrite the block's hidden content) — the plan never merges records.
    const lane = fakeSession("conv-a", [{ id: "b1", rawIds: [], tokens: 0, active: false }], []);
    const donor = fakeSession("conv-a|sub:919f2f1b4676a9ad", [{ id: "b1", rawIds: ["raw1"], tokens: 900 }], ["raw1"]);
    const { log, lines } = logger();
    const result = recoverFoldsFromSibling({
        session: lane,
        incomingIds: new Set(["raw1"]),
        deps: depsOf({ "conv-a": lane, "conv-a|sub:919f2f1b4676a9ad": donor }),
        log,
    });
    assert.equal(result.adopted, 0);
    assert.equal(lane.state.blocks.length, 1, "the lane's own block record stays as it was");
    assert.equal(lane.state.blocks[0].active, false, "and is not silently activated by an adoption");
    assert.ok(lines.some((l) => l.includes("already exists")), "the block collision is the logged reason");
});

test("#4046 recovery ignores a sibling lane written for another protocol", () => {
    // Refs, message ids and the block sidecar store are protocol-shaped; a
    // ledger from another wire protocol cannot be half-adopted safely.
    const lane = fakeSession("conv-a", [], []);
    lane.meta.protocol = "anthropic";
    const donor = fakeSession("conv-a|sub:919f2f1b4676a9ad", [{ id: "b1", rawIds: ["raw1"], tokens: 900 }], ["raw1"]);
    donor.meta.protocol = "openai";
    const { log, lines } = logger();
    const result = recoverFoldsFromSibling({
        session: lane,
        incomingIds: new Set(["raw1"]),
        deps: depsOf({ "conv-a": lane, "conv-a|sub:919f2f1b4676a9ad": donor }),
        log,
    });
    assert.equal(result.adopted, 0);
    assert.equal(lane.state.blocks.length, 0);
    assert.ok(lines.some((l) => l.includes("protocol openai")), "a cross-protocol donor must be named in the log");
});

test("#4046 recovery survives a corrupt donor and bounded donor scans", () => {
    const lane = fakeSession("conv-a", [], []);
    const donorIds = Array.from({ length: 12 }, (_, i) => `conv-a|sub:${String(i).padStart(16, "0")}`);
    const sessions: Record<string, Session> = { "conv-a": lane };
    for (const id of donorIds) sessions[id] = fakeSession(id, [{ id: "b1", rawIds: ["raw1"], tokens: 10 }], ["raw1"]);
    const deps: FoldRecoveryDeps = {
        knownSessionIds: () => Object.keys(sessions),
        loadSession: (id) => {
            if (id.endsWith("000000000000")) throw new Error("corrupt donor file");
            return sessions[id] ?? null;
        },
        peek: () => undefined,
    };
    const { log } = logger();
    const result = recoverFoldsFromSibling({ session: lane, incomingIds: new Set(["raw1"]), deps, log, maxDonors: 3 });
    assert.equal(result.scanned, 3, "the scan is capped");
    assert.equal(result.adopted, 1, "a throwing donor must not abort the others");
});

test("#4046 foldRecoveryGate refuses every non-replay shape and bounds the retries", () => {
    // The gate used to live inline in maybeRecoverFoldsFromSibling, where no test
    // could reach it: deleting a condition (or the whole retry cap) left the
    // suite green. These assertions make each condition load-bearing.
    const lane = fakeSession("conv-a", [], []);
    assert.deepEqual(foldRecoveryGate(lane, 40), { run: true, tries: 0 }, "a lost ledger + a full replay is exactly the case");

    // A lane that still owns blocks is healthy — nothing to recover.
    const healthy = fakeSession("conv-a", [{ id: "own", rawIds: ["raw1"], tokens: 10 }], ["raw1"]);
    assert.equal(foldRecoveryGate(healthy, 40).run, false);

    // A subagent skeleton lane has no transcript to recover.
    const skeleton = fakeSession("conv-a|sub:task:1234abcd", [], []);
    assert.equal(foldRecoveryGate(skeleton, 40).run, false);

    // Never served a request = not a replay (keeps fresh conversations off the
    // discovery path).
    const virgin = fakeSession("conv-a", [], []);
    virgin.stats.requests = 0;
    assert.equal(foldRecoveryGate(virgin, 40).run, false);

    // Too small to matter: the scan is synchronous disk I/O on the request path.
    assert.equal(foldRecoveryGate(lane, 7).run, false, "below RECOVERY_MIN_INCOMING the gate stays shut");
    assert.equal(foldRecoveryGate(lane, 8).run, true, "and exactly at it, open");

    // Bounded retries: a latch (complete adoption) is permanent, a spent budget
    // is permanent, and the third attempt is the last one.
    const latched = fakeSession("conv-a", [], []);
    latched.metadata.foldRecoveryTried = true;
    assert.equal(foldRecoveryGate(latched, 40).run, false, "a complete adoption latches");

    const spent = fakeSession("conv-a", [], []);
    spent.metadata.foldRecoveryTries = 3;
    assert.equal(foldRecoveryGate(spent, 40).run, false, "RECOVERY_MAX_TRIES is a hard cap");
    const lastChance = fakeSession("conv-a", [], []);
    lastChance.metadata.foldRecoveryTries = 2;
    assert.deepEqual(foldRecoveryGate(lastChance, 40), { run: true, tries: 2 }, "the last allowed attempt still runs");
});

test("#4046 mergeAdoptedContentStore keeps the lane's own originals", () => {
    // adoptContentStore swaps the whole store, so handing it the donor slice
    // alone would delete originals this lane already owned (a deleted block keeps
    // its content, #2695). The merge is first-write-wins per ref.
    const own: MessageContentStore = {
        version: 1,
        byHash: { h1: "TARGET-ONLY-ORIGINAL" },
        byRef: { m00001: { hash: "h1", kind: "text", tokens: 5, rawId: "raw1", chars: 5, head: "TARGET" } },
    };
    const donor: MessageContentStore = {
        version: 1,
        byHash: { h1: "DONOR-DIFFERENT-TEXT", h2: "DONOR-ORIGINAL" },
        byRef: {
            m00001: { hash: "h1", kind: "text", tokens: 5, rawId: "raw1", chars: 5, head: "DONOR" },
            m00002: { hash: "h2", kind: "text", tokens: 7, rawId: "raw2", chars: 7, head: "DONOR" },
        },
    };
    const merged = mergeAdoptedContentStore(own, donor);
    assert.notEqual(merged, null);
    assert.equal(merged!.byRef.m00001.hash, "h1", "the lane's own entry stays authoritative for a ref both sides hold");
    assert.equal(merged!.byHash.h1, "TARGET-ONLY-ORIGINAL", "and its original text is NOT replaced by the donor's");
    assert.equal(merged!.byRef.m00002.hash, "h2", "the donor fills refs the lane never had");
    assert.equal(merged!.byHash.h2, "DONOR-ORIGINAL");
    // Degenerate shapes: nothing to adopt keeps what the lane has; a lane with no
    // store takes the donor slice as-is.
    assert.equal(mergeAdoptedContentStore(own, null), own);
    assert.equal(mergeAdoptedContentStore(undefined, donor), donor);
    assert.equal(mergeAdoptedContentStore(undefined, null), null);
});
