import test from "node:test";
import assert from "node:assert/strict";
import {
    conversationOf,
    pickFoldDonor,
    recoverFoldsFromSibling,
    siblingLaneIds,
    type FoldRecoveryDeps,
} from "../src/fork-adoption.ts";
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
