import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    auditDshSessions,
    checkDshSessionLog,
    checkDshSessionRecords,
    refuseHostLogWrite,
} from "../src/dsh-session-audit.ts";
import { DshRestoreError, readDshSessionRecords } from "../src/dsh-restore.ts";
import { rmrf } from "./tmp-rm.ts";

// 2026-10-21 regression: `bili restore --write` deleted compaction events from
// DSH's append-only log without renumbering `seq`, so DSH's strict reader threw
// "seq gap (expected 2549, got 2550)" and refused 10 whole sessions. These cases
// pin (a) the audit detects a gap, (b) the audit is read-only, (c) no write path
// can be reached from the CLI module.

/** A seq-contiguous log: header (no seq), then events 0..n-1. */
function cleanLog(compacted = false): string {
    const events: Array<Record<string, unknown>> = [{ type: "session", version: 4, id: "s1" }];
    let seq = 0;
    const push = (e: Record<string, unknown>): void => {
        events.push({ seq, time: 1_000 + seq, ...e });
        seq++;
    };
    push({ type: "user/message" });
    push({ type: "assistant/message" });
    push({ type: "tool/call" });
    push({ type: "tool/result" });
    if (compacted) {
        push({ type: "compaction/prune", data: { shadowedSeqs: [0, 1], shadowedTokenCount: 100 } });
        push({ type: "compaction/start", data: { compactionId: "c1" } });
        push({ type: "compaction/summary", data: { compactionId: "c1", shadowedSeqs: [0, 1], shadowedTokenCount: 100, summary: [] } });
        push({ type: "user/message" }); // injected checkpoint
        push({ type: "compaction/end", data: { compactionId: "c1" } });
    }
    push({ type: "user/message" });
    return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

test("#4046 audit: a seq-contiguous log is clean and its last seq is reported", () => {
    const check = checkDshSessionRecords(readDshSessionRecords(Buffer.from(cleanLog(), "utf8")));
    assert.equal(check.gap, null);
    assert.equal(check.events, 6, "5 released rows + the header event");
    assert.equal(check.lastSeq, 4, "the header carries no seq, so released rows are 0..4");
    assert.equal(check.compactionEvents, 0);
    assert.equal(check.compactedSeqs, 0);
});

test("#4046 audit: a compacted-but-intact log reports compaction, not corruption", () => {
    const check = checkDshSessionRecords(readDshSessionRecords(Buffer.from(cleanLog(true), "utf8")));
    assert.equal(check.gap, null, "DSH compaction is non-destructive to the log");
    assert.equal(check.compactionEvents, 4, "prune + start + summary + end (the checkpoint is a user/message)");
    assert.equal(check.compactedSeqs, 2);
    assert.equal(check.missingShadowedEvents, 0);
});

test("#4046 audit: the exact 2026-10-21 damage (a deleted event) is reported as a gap", () => {
    const lines = cleanLog(true).trim().split("\n");
    // Drop the prune row the way the old tool did: surviving events keep their
    // old numbers, so the next one is +2 instead of +1.
    const withoutPrune = lines.filter((l) => !l.includes('"compaction/prune"'));
    const check = checkDshSessionRecords(readDshSessionRecords(Buffer.from(withoutPrune.join("\n") + "\n", "utf8")));
    assert.notEqual(check.gap, null, "the audit must see the hole DSH would refuse on");
    assert.equal(check.gap!.expected, 4);
    assert.equal(check.gap!.got, 5);
});

test("#4046 audit: scanning a tree separates ok / compacted / corrupt", () => {
    const root = mkdtempSync(join(tmpdir(), "bili-audit-tree-"));
    try {
        const put = (name: string, body: string): string => {
            const dir = join(root, name);
            mkdirSync(dir, { recursive: true });
            const file = join(dir, "session.v4.jsonl");
            writeFileSync(file, body);
            return file;
        };
        put("clean", cleanLog());
        put("compacted", cleanLog(true));
        const broken = cleanLog(true).trim().split("\n").filter((l) => !l.includes('"compaction/start"'));
        put("corrupt", broken.join("\n") + "\n");

        const audit = auditDshSessions(root);
        assert.equal(audit.scanned, 3);
        assert.equal(audit.ok, 1);
        assert.equal(audit.compacted, 1);
        assert.equal(audit.corrupt, 1);
        assert.equal(audit.errors, 0);
        assert.ok(readFileSync(join(root, "compacted", "session.v4.jsonl"), "utf8").includes("compaction/"), "audit never rewrites");
        assert.equal(checkDshSessionLog(join(root, "corrupt", "session.v4.jsonl")).gap!.expected >= 0, true);
    } finally {
        rmrf(root);
    }
});

test("#4046 audit: the write guard refuses with an actionable message", () => {
    assert.throws(
        () => refuseHostLogWrite(),
        (e: unknown) => e instanceof DshRestoreError && /never writes DSH session logs/.test(e.message) && /Nothing was changed/.test(e.message),
    );
});
