import assert from "node:assert/strict";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import {
    DshRestoreError,
    planDshRestore,
    readDshSessionRecords,
    restoreDshSessionBuffer,
    resolveSessionLogPath,
    runDshRestoreFile,
} from "../src/dsh-restore.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmrf } from "./tmp-rm.ts";

// #4046 follow-up: DSH's native compaction shadows history behind
// compaction/* events. `bili restore` un-shadows it offline. The transform must
// be all-or-nothing (a partial restore is worse than none) and must never
// rewrite a surviving record — these cases pin both properties, in plain JSONL
// and in the concatenated-zstd live format.

interface Ev {
    type: string;
    seq: number;
    time?: number;
    data?: Record<string, unknown>;
}

function log(events: Ev[]): string {
    return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

const base: Ev[] = [
    { type: "session", seq: 0 },
    { type: "user/message", seq: 5 },
    { type: "assistant/message", seq: 6 },
    { type: "tool/result", seq: 7 },
    { type: "compaction/prune", seq: 8, data: { shadowedSeqs: [5], shadowedTokenCount: 100 } },
    { type: "compaction/prune", seq: 9, data: { shadowedSeqs: [6], shadowedTokenCount: 200 } },
    { type: "compaction/start", seq: 10, data: { compactionId: "c1" } },
    { type: "compaction/summary", seq: 11, data: { compactionId: "c1", shadowedSeqs: [5, 6, 7], shadowedTokenCount: 300, summary: [{ type: "text", text: "checkpoint" }] } },
    { type: "user/message", seq: 12 },
    { type: "compaction/end", seq: 13, data: { compactionId: "c1" } },
    { type: "user/message", seq: 14 },
];

test("#4046 restore: drops the compaction events and the injected checkpoint, keeps every message", () => {
    const buffer = Buffer.from(log(base), "utf8");
    const records = readDshSessionRecords(buffer);
    const plan = planDshRestore(records);
    assert.equal(plan.report.droppedCompactionEvents, 5, "prune x2 + start + summary + end are compaction events");
    assert.equal(plan.report.droppedCheckpointMessages, 1, "the user/message right after the summary is generated content");
    assert.equal(plan.report.shadowedSeqs, 3);
    assert.equal(plan.report.shadowedTokens, 300);
    assert.equal(plan.report.messageEventsBefore, 5);
    assert.equal(plan.report.messageEventsAfter, 4);
    const { output, report } = restoreDshSessionBuffer(buffer);
    const outSeqs = readDshSessionRecords(output).flatMap((r) => r.events.map((e) => e.seq));
    assert.deepEqual(outSeqs, [0, 5, 6, 7, 14], "the real history and the post-compaction turn survive; only seq 12 (checkpoint) goes");
    assert.equal(report.records, 11);
    assert.equal(output.toString("utf8").trim().split("\n").length, 5);
    assert.ok(!output.toString("utf8").includes("compaction/"), "no compaction event survives");
});

test("#4046 restore: refuses when a shadowed message has no surviving event", () => {
    const broken: Ev[] = [...base];
    broken[4] = { type: "compaction/prune", seq: 8, data: { shadowedSeqs: [5, 999], shadowedTokenCount: 100 } };
    const records = readDshSessionRecords(Buffer.from(log(broken), "utf8"));
    assert.throws(
        () => planDshRestore(records),
        (e: unknown) => e instanceof DshRestoreError && e.code === "unsafe" && /999/.test(e.message),
    );
});

test("#4046 restore: a log with no compaction is a no-op, not a rewrite", () => {
    const clean = log(base.filter((e) => !e.type.startsWith("compaction/") && e.seq !== 12));
    const records = readDshSessionRecords(Buffer.from(clean, "utf8"));
    assert.throws(() => planDshRestore(records), (e: unknown) => e instanceof DshRestoreError && e.code === "nothing-to-do");
});

test("#4046 restore: unparseable records are refused, never skipped", () => {
    const bad = log(base.slice(0, 3)) + "{not json}\n";
    assert.throws(
        () => readDshSessionRecords(Buffer.from(bad, "utf8")),
        (e: unknown) => e instanceof DshRestoreError && e.code === "unparseable",
    );
});

test("#4046 restore: the concatenated-zstd live format round-trips with frames copied byte-for-byte", () => {
    const frames = base.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e), "utf8")));
    const live = Buffer.concat(frames);
    const records = readDshSessionRecords(live);
    assert.equal(records.length, base.length, "every concatenated frame is found");
    const { output, compressed, report } = restoreDshSessionBuffer(live);
    assert.equal(compressed, true);
    assert.equal(report.droppedCompactionEvents, 5);
    // Output must be valid concatenated frames again, and each kept frame must be
    // the ORIGINAL bytes (a re-encode could change compression but must not be
    // necessary: survivors are copied).
    const outRecords = readDshSessionRecords(output);
    assert.deepEqual(outRecords.flatMap((r) => r.events.map((e) => e.seq)), [0, 5, 6, 7, 14]);
    const keptOriginal = frames.filter((_, i) => [0, 1, 2, 3, 10].includes(i));
    assert.equal(output.length, Buffer.concat(keptOriginal).length);
    assert.ok(output.equals(Buffer.concat(keptOriginal)), "surviving frames are byte-identical");
});

test("#4046 restore file runner: dry-run writes nothing, write mode backs up first", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-restore-"));
    try {
        const file = join(dir, "session.v4.jsonl");
        const original = Buffer.from(log(base), "utf8");
        writeFileSync(file, original);
        assert.equal(resolveSessionLogPath(dir), file, "a session DIRECTORY resolves to its log file");

        const dry = runDshRestoreFile(dir);
        assert.equal(dry.dryRun, true);
        assert.equal(dry.outputPath, null);
        assert.ok(readFileSync(file).equals(original), "dry-run must not touch the file");

        const real = runDshRestoreFile(file, { write: true });
        assert.equal(real.dryRun, false);
        assert.ok(real.backupPath !== null);
        assert.ok(readFileSync(real.backupPath).equals(original), "the backup is a byte-exact copy");
        assert.ok(!readFileSync(file).toString("utf8").includes("compaction/"), "the live file is restored");
    } finally {
        rmrf(dir);
    }
});
