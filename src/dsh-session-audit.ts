import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { DshRestoreError, readDshSessionRecords, type DshSessionRecord } from "./dsh-restore.js";

/**
 * Read-only audit of DSH v4 session logs.
 *
 * WHY READ-ONLY: on 2026-10-21 the shipped `bili restore --write` removed
 * compaction events from append-only DSH logs WITHOUT renumbering `seq`. DSH's
 * history reader is strict — `event.seq === eventCount` — so the first gap
 * turned 10 sessions into "stored session is corrupt: seq gap" and none of them
 * could be opened. The data was intact; the tool's contract was wrong.
 *
 * RULE FROM NOW ON: bili NEVER writes a DSH session log. Not in place, not via
 * a temporary file + rename, not "only when DSH is closed". The host owns that
 * format; a plugin that edits it can render a conversation unusable, which is
 * unacceptable. This module only READS: it reports whether each log is
 * (a) sequential and clean, (b) sequential but compacted (some events shadowed
 * by DSH's native compaction — a model-view issue, never a data loss), or
 * (c) structurally damaged (a seq gap that already exists on disk).
 */

/** First seq discontinuity in a log, if any. DSH requires the released rows to
 *  number 0..N without gaps (the session header carries no seq). */
export interface DshSeqGap {
    expected: number;
    got: number;
    eventIndex: number;
}

export interface DshSessionCheck {
    records: number;
    events: number;
    lastSeq: number;
    gap: DshSeqGap | null;
    /** Events DSH's native compaction shadowed (prune + summary lists). */
    compactedSeqs: number;
    compactionEvents: number;
    missingShadowedEvents: number;
}

/** Pure check over already-read records. */
export function checkDshSessionRecords(records: readonly DshSessionRecord[]): DshSessionCheck {
    const events = records.flatMap((r) => r.events);
    let expected = 0;
    let lastSeq = -1;
    let gap: DshSeqGap | null = null;
    let eventIndex = 0;
    const shadowed = new Set<number>();
    const present = new Set<number>();
    let compactionEvents = 0;
    for (const e of events) {
        const seq = typeof e.seq === "number" ? e.seq : undefined;
        if (seq !== undefined) {
            present.add(seq);
            if (seq !== expected && gap === null) gap = { expected, got: seq, eventIndex };
            if (seq > lastSeq) lastSeq = seq;
            expected = seq + 1;
        } else if (gap === null && lastSeq >= 0) {
            // A non-numeric-seq event after the header chain is unexpected in v4.
            gap = { expected, got: -1, eventIndex };
        }
        if (typeof e.type === "string" && e.type.startsWith("compaction/")) {
            compactionEvents++;
            const data = e.data as { shadowedSeqs?: unknown } | undefined;
            if (Array.isArray(data?.shadowedSeqs)) {
                for (const s of data.shadowedSeqs) if (typeof s === "number") shadowed.add(s);
            }
        }
        eventIndex++;
    }
    let missingShadowedEvents = 0;
    for (const s of shadowed) if (!present.has(s)) missingShadowedEvents++;
    return {
        records: records.length,
        events: events.length,
        lastSeq,
        gap,
        compactedSeqs: shadowed.size,
        compactionEvents,
        missingShadowedEvents,
    };
}

export function checkDshSessionLog(path: string): DshSessionCheck {
    return checkDshSessionRecords(readDshSessionRecords(readFileSync(path)));
}

export type DshAuditStatus = "ok" | "compacted" | "corrupt" | "error";

export interface DshAuditEntry {
    path: string;
    status: DshAuditStatus;
    check?: DshSessionCheck;
    error?: string;
}

export interface DshAuditResult {
    root: string;
    scanned: number;
    ok: number;
    compacted: number;
    corrupt: number;
    errors: number;
    entries: DshAuditEntry[];
}

/** Every session log under `root` (the live `.jsonl.zstd` form preferred). */
export function findSessionLogs(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number): void => {
        if (depth > 4) return;
        let names: string[];
        try {
            names = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of names) {
            const full = join(dir, name);
            let isDir = false;
            try {
                isDir = statSync(full).isDirectory();
            } catch {
                continue;
            }
            if (isDir) {
                walk(full, depth + 1);
                continue;
            }
            if (name === "session.v4.jsonl.zstd" || name === "session.v4.jsonl") out.push(full);
        }
    };
    walk(root, 0);
    return out.sort();
}

/** READ-ONLY audit of every DSH session under `root`. Never writes anything. */
export function auditDshSessions(root: string): DshAuditResult {
    const logs = findSessionLogs(root);
    const entries: DshAuditEntry[] = [];
    for (const path of logs) {
        try {
            const check = checkDshSessionLog(path);
            const status: DshAuditStatus = check.gap !== null ? "corrupt" : check.compactionEvents > 0 ? "compacted" : "ok";
            entries.push({ path, status, check });
        } catch (e) {
            entries.push({ path, status: "error", error: e instanceof Error ? e.message : String(e) });
        }
    }
    return {
        root,
        scanned: entries.length,
        ok: entries.filter((e) => e.status === "ok").length,
        compacted: entries.filter((e) => e.status === "compacted").length,
        corrupt: entries.filter((e) => e.status === "corrupt").length,
        errors: entries.filter((e) => e.status === "error").length,
        entries,
    };
}

export function renderDshAuditReport(result: DshAuditResult): string {
    const lines = [
        `sessions root: ${result.root}`,
        `scanned ${result.scanned}: ok ${result.ok}, compacted ${result.compacted}, corrupt ${result.corrupt}, errors ${result.errors}`,
    ];
    for (const e of result.entries) {
        if (e.status === "ok") continue;
        if (e.status === "error") {
            lines.push(`  [error] ${e.path} — ${e.error ?? ""}`);
            continue;
        }
        const c = e.check!;
        if (e.status === "corrupt") {
            lines.push(`  [CORRUPT] ${e.path} — seq gap at event ${c.gap!.eventIndex}: expected ${c.gap!.expected}, got ${c.gap!.got} (${c.events} events, last seq ${c.lastSeq})`);
            continue;
        }
        lines.push(
            `  [compacted] ${e.path} — ${c.compactionEvents} compaction event(s), ${c.compactedSeqs} shadowed seq(s)${c.missingShadowedEvents > 0 ? `, ${c.missingShadowedEvents} already absent from the log` : ""} (model-view only; data intact)`,
        );
    }
    lines.push("read-only: bili never writes DSH session logs (un-shielding is not a safe operation on the host's append-only format).");
    return `${lines.join("\n")}\n`;
}

/** Guard used by every code path that used to write: it must be impossible to
 *  reach a write from the CLI. Kept exported so tests pin the refusal text. */
export function refuseHostLogWrite(): never {
    throw new DshRestoreError(
        "bili never writes DSH session logs: removing events breaks the append-only seq chain and the host then refuses to open the session " +
            "(2026-10-21 incident: 10 sessions corrupt). Nothing was changed. The original history is intact in the host's log; this tool is read-only.",
        "io",
    );
}
