// #P3-B: reconcileFoldCoverage OUTPUT FREEZE.
//
// `reconcileFoldCoverage` is the one place where a whole session's fold state is
// re-derived from the resent wire. The cold round mints an anchor for every
// covered message (normalized identity, no-toolCallId twin, turn key, simhash,
// word bag) and rolls the order backbone + positional copy forward. Those
// constants dominate the per-request cost, so the optimization work here is
// constant-factor only — which means the ONLY acceptable diff is "same bytes,
// less time".
//
// This test is the lock: it drives one deterministic session through the whole
// claim ladder (cold seed → whitespace churn → protocol shape flip → steady
// resend → mid-history insertion with a Pass-0 gap → steady) and freezes a
// canonical JSON snapshot of EVERYTHING the pass produces — result counters,
// block id lists, and the whole reconciliation metadata (foldAnchors /
// foldAnchorOrder / foldPositions / foldCoverageByBlock). Volatile wall-clock
// fields (foldDriftSince, conflictEvents[].at) are scrubbed; everything else is
// compared by sha256, so any semantic drift in coverage, anchor reuse, claims
// or reaping fails here byte-for-byte.
//
// Regenerate deliberately (never to make a failure go green):
//   SNAPSHOT_PRINT=1 node --import tsx --test tests/fold-reconcile-cold-snapshot.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    reconcileFoldCoverage,
    canonicalJson,
    canonicalTextOf,
    wordBagDigest,
    type FoldReconcileResult,
} from "../src/fold-reconcile.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

/** sha256 of the frozen snapshot below — the whole point of this file. */
const EXPECTED_SHA256 = "effcd945e3aca2c83e992fa051983c602d876cbb0a54980a6100965dd399298b";

// ---------------------------------------------------------------------------
// Deterministic corpus. Short messages (the algorithms are byte-proportional,
// so size does not change WHAT they compute, only how long it takes), but every
// shape that reaches a different branch:
//   - plain prose user/assistant cores,
//   - a reasoning core paired with a text core (turn-key pairing, #2636),
//   - tool-call cores whose text is a JSON payload (canonicalJson branch of
//     canonicalTextOf, #2480) + their tool-result twins,
//   - non-ASCII text (NFC), CRLF + trailing-space churn (normalizeMessageText).
// ---------------------------------------------------------------------------
const TOOL_ARGS = [
    '{"command":"ls","flags":["-la","-h"],"cwd":"/tmp/a"}',
    '{"command":"grep","pattern":"fold","path":"src"}',
    '{"command":"cat","files":["README.md"]}',
];

function userText(i: number): string {
    if (i % 5 === 0) return `turn ${i}: 请检查 fold 路径 — running with a non-ASCII body to exercise NFC\r\n`;
    if (i % 7 === 0) return `turn ${i}:   padded line with CRLF churn   \r\n second line   `;
    return `turn ${i}: plain question body with words ${i}`;
}

function assistantText(i: number): string {
    return `answer ${i}: the fold path reconciles the resent history against the anchor set (${i * 7} tokens).`;
}

interface CorpusOpts {
    /** Re-mint every 3rd id with formatting-level churn (normalized bytes equal). */
    churn?: boolean;
    /** Collapse reasoning+text pairs into ONE merged tagged text core (#3301). */
    merged?: boolean;
    /** Insert one brand-new message near the head (shifts every later position). */
    inserted?: boolean;
}

function corpus(opts: CorpusOpts = {}): CoreMessage[] {
    const out: CoreMessage[] = [];
    const churn = (id: string, text: string): { id: string; text: string } =>
        opts.churn && Number(id.slice(1)) % 3 === 0
            ? { id: `${id}_c`, text: text.replace(/ /g, "  ").replace(/\n/g, "\r\n") + "  " }
            : { id, text };
    if (opts.inserted) out.push({ id: "ins_0", role: "user", contentType: "text", text: "a brand new leading question" });
    for (let i = 0; i < 24; i++) {
        const u = churn(`t${i}u`, userText(i));
        out.push({ id: u.id, role: "user", contentType: "text", text: u.text });
        const a = churn(`t${i}a`, assistantText(i));
        if (opts.merged) {
            // #2636/#3301: same turn bytes, one merged core (thinking inlined).
            const tagged = `<think>\nrs_${i}\n</think>\n${a.text}`;
            const m = churn(`t${i}a`, tagged);
            out.push({ id: m.id, role: "assistant", contentType: "text", text: m.text });
        } else {
            out.push({ id: `t${i}r`, role: "assistant", contentType: "reasoning", text: `rs_${i}` });
            out.push({ id: a.id, role: "assistant", contentType: "text", text: a.text });
        }
        if (i % 3 === 0) {
            const c = churn(`t${i}t`, TOOL_ARGS[(i / 3) % TOOL_ARGS.length]!);
            out.push({ id: c.id, role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: `call_${i}`, text: c.text });
            out.push({ id: `t${i}o`, role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: `call_${i}`, text: `result ${i}: ok` });
        }
    }
    return out;
}

/** Session shape the wire sites hand to the pass: two live blocks splitting the
 *  covered span, plus one retained view-deactivated block whose lineage is
 *  re-fed into the claim ladder (#4050). */
function sessionFor(msgs: CoreMessage[]): Session {
    const ids = msgs.map((m) => m.id!);
    const half = Math.floor(ids.length / 2);
    return {
        id: "snapshot",
        state: {
            blocks: [
                { blockId: "b0", active: true, effectiveMessageIds: ids.slice(0, half), directMessageIds: [] },
                { blockId: "b1", active: true, effectiveMessageIds: ids.slice(half), directMessageIds: [] },
                { blockId: "b2", active: false, effectiveMessageIds: ["t1u", "t2a"], directMessageIds: [] },
            ],
        },
        metadata: {},
    } as unknown as Session;
}

/** Strip the wall-clock fields; everything else is frozen. */
function scrub(metadata: Record<string, unknown>): unknown {
    const copy = JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>;
    delete copy.foldDriftSince;
    const events = copy.conflictEvents;
    if (Array.isArray(events)) {
        copy.conflictEvents = events.map((e: { kind?: unknown; detail?: unknown }) => ({ kind: e.kind, detail: e.detail }));
    }
    return copy;
}

interface PassRecord {
    label: string;
    result: FoldReconcileResult;
    blocks: Array<{ blockId?: string; active?: boolean; effectiveMessageIds?: string[]; directMessageIds?: string[] }>;
    metadata: unknown;
}

function record(label: string, session: Session, result: FoldReconcileResult): PassRecord {
    const blocks = (session.state?.blocks ?? []) as PassRecord["blocks"];
    return {
        label,
        result,
        blocks: blocks.map((b) => ({
            blockId: b.blockId,
            active: b.active,
            effectiveMessageIds: b.effectiveMessageIds,
            directMessageIds: b.directMessageIds,
        })),
        metadata: scrub((session.metadata ?? {}) as Record<string, unknown>),
    };
}

/** Drive the six passes and serialize everything they produce. */
function snapshot(): string {
    const opts = { mode: "repair" as const, sessionId: "snapshot", log: () => {} };
    const records: PassRecord[] = [];

    const cold = corpus();
    const session = sessionFor(cold);
    records.push(record("cold", session, reconcileFoldCoverage(session, cold, opts)));

    // 1) formatting-level churn: same normalized bytes under fresh ids.
    const churned = corpus({ churn: true });
    records.push(record("churn", session, reconcileFoldCoverage(session, churned, opts)));

    // 2) protocol shape flip: reasoning+text pair replayed as one merged core.
    const flipped = corpus({ merged: true });
    records.push(record("shape-flip", session, reconcileFoldCoverage(session, flipped, opts)));

    // 3) steady resend of the same bytes (anchor reuse path).
    records.push(record("steady", session, reconcileFoldCoverage(session, flipped, opts)));

    // 4) mid-history insertion: every later position shifts by one (Pass 0 gap
    //    + resync), and the stored positional copy has to roll forward.
    const shifted = corpus({ merged: true, inserted: true });
    records.push(record("insertion", session, reconcileFoldCoverage(session, shifted, opts)));

    // 5) steady resend after the shift.
    records.push(record("steady-2", session, reconcileFoldCoverage(session, shifted, opts)));

    return records.map((r) => canonicalJson(r as unknown)).join("\n");
}

function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

describe("reconcileFoldCoverage output freeze (#P3-B constant-factor work)", () => {
    test("whole-session snapshot sha256 is unchanged", () => {
        const snap = snapshot();
        const digest = sha256(snap);
        if (process.env.SNAPSHOT_PRINT === "1") {
            console.log(`SNAPSHOT_SHA256=${digest}\nSNAPSHOT_BYTES=${snap.length}`);
        }
        assert.equal(digest, EXPECTED_SHA256, "reconcile output drifted — coverage / anchor reuse / reaped must stay byte-identical");
    });

    // The cold-round fast path replaced the word-bag digest's
    // toLowerCase+matchAll pipeline with an ASCII scanner. The snapshot above
    // covers the corpus, but a digest that silently diverges only on some
    // punctuation/case/whitespace shape would poison every persisted `wh`
    // anchor (mismatch = refuse, so folds would stop re-anchoring). Pin the
    // algorithm itself against the frozen reference over an adversarial
    // alphabet.
    test("wordBagDigest ASCII fast path === frozen reference implementation", () => {
        const reference = (text: string): number => {
            const wordHash = (w: string): number => {
                let h = 0x811c9dc5;
                for (let i = 0; i < w.length; i++) {
                    h ^= w.charCodeAt(i);
                    h = Math.imul(h, 0x01000193) >>> 0;
                }
                return h;
            };
            let acc = 1;
            for (const m of text.toLowerCase().matchAll(/\p{L}+|\p{N}+/gu)) {
                acc = (acc + wordHash(m[0])) % 0x1fffffffffffff;
            }
            return acc;
        };
        const ALPHABET = [
            "a", "Z", "0", "9", "_", " ", "\t", "\n", "\r\n", "-", ".", "{", "}", ":", ",",
            "é", "ß", "İ", "가", "😀", "\u00a0", "\u2028", "\u0301", "ab12", "1a2B", "x_y", "",
        ];
        let seed = 0xc0ffee;
        const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
        for (let t = 0; t < 6000; t++) {
            let s = "";
            const len = Math.floor(rnd() * 10);
            for (let k = 0; k < len; k++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
            assert.equal(wordBagDigest(s), reference(s), `word bag drifted on ${JSON.stringify(s)}`);
        }
        // and every canonical payload the reconcile test corpus actually hashes
        for (const m of corpus({ churn: true })) {
            const canon = canonicalTextOf(m.text ?? "");
            assert.equal(wordBagDigest(canon), reference(canon), `word bag drifted on corpus payload ${m.id}`);
        }
    });
});
