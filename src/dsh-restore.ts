import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

/**
 * DSH v4 session-log restore.
 *
 * WHY: DSH persists a session as an append-only event log (`session.v4.jsonl`,
 * usually a sequence of zstd frames — one or more newline-separated events per
 * frame). Its NATIVE compaction appends `compaction/start` ->
 * `compaction/summary` -> (an injected checkpoint `user/message`) ->
 * `compaction/end` plus one `compaction/prune` per shadowed message. Replaying
 * that log hands the MODEL only the checkpoint while the original events are
 * still in the file — a user who disables/uninstalls bili can end up with a
 * session whose visible history is intact but whose model context is one 4K-token
 * summary (2026-10-21 incident: 650,923 tokens collapsed to 4,491, 99.31% lost).
 *
 * This module neutralizes the compaction offline: it drops the compaction events
 * and the injected checkpoint message, keeps every other event, and copies a
 * frame BYTE-IDENTICAL whenever no event inside it was dropped. Safety rules
 * refuse (never half-apply) when a shadowed seq has no surviving event, when a
 * message event would vanish beyond the known checkpoint, or when a record is
 * not parseable.
 */

const DROP_TYPES = new Set(["compaction/start", "compaction/summary", "compaction/end", "compaction/prune"]);
const MESSAGE_TYPES = new Set(["user/message", "assistant/message", "tool/call", "tool/result", "system/message", "developer/message"]);

export class DshRestoreError extends Error {
    constructor(
        message: string,
        readonly code: "unparseable" | "nothing-to-do" | "unsafe" | "io" = "unsafe",
    ) {
        super(message);
        this.name = "DshRestoreError";
    }
}

export interface DshSessionEvent {
    type?: unknown;
    seq?: unknown;
    [key: string]: unknown;
}

/** One on-disk record: a zstd frame (or one JSONL line) plus the events it
 *  carries and the exact byte range it occupies. A frame is copied through
 *  untouched when every event in it survives. */
export interface DshSessionRecord {
    start: number;
    end: number;
    events: DshSessionEvent[];
}

export interface DshRestoreReport {
    records: number;
    /** Shadowed seqs whose event is absent from the log (only non-zero in
     *  --allow-gaps mode: nothing can restore those, the rest is still un-shadowed). */
    missingShadowed?: number;
    events: number;
    droppedCompactionEvents: number;
    droppedCheckpointMessages: number;
    shadowedSeqs: number;
    shadowedTokens: number;
    messageEventsBefore: number;
    messageEventsAfter: number;
    keptBytes: number;
}

export function isZstd(buffer: Buffer): boolean {
    return buffer.length >= 4 && buffer[0] === 0x28 && buffer[1] === 0xb5 && buffer[2] === 0x2f && buffer[3] === 0xfd;
}

/** Length of one zstd frame starting at `offset` (RFC 8878 frame header +
 *  blocks + optional checksum). Needed because DSH concatenates thousands of
 *  independent frames into one file, which `zstdDecompressSync` does not walk. */
export function zstdFrameLength(buffer: Buffer, offset: number): number {
    if (!isZstd(buffer.subarray(offset, offset + 4))) throw new DshRestoreError(`no zstd frame at offset ${offset}`, "unparseable");
    let p = offset + 4;
    const fhd = buffer[p++];
    const fcsFlag = (fhd >> 6) & 0x3;
    const singleSegment = (fhd >> 5) & 0x1;
    const checksum = (fhd >> 2) & 0x1;
    const dictFlag = fhd & 0x3;
    if (((fhd >> 3) & 0x1) !== 0) throw new DshRestoreError("reserved zstd frame-header bit set", "unparseable");
    if (!singleSegment) p += 1; // Window_Descriptor
    p += dictFlag === 3 ? 4 : dictFlag; // Dictionary_ID
    p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
    for (;;) {
        if (p + 3 > buffer.length) throw new DshRestoreError("truncated zstd block header", "unparseable");
        const header = buffer[p] | (buffer[p + 1] << 8) | (buffer[p + 2] << 16);
        p += 3;
        const last = header & 0x1;
        const type = (header >> 1) & 0x3;
        const size = header >> 3;
        if (type === 3) throw new DshRestoreError("reserved zstd block type", "unparseable");
        p += type === 1 ? 1 : size; // RLE carries one byte, raw/compressed carry `size`
        if (p > buffer.length) throw new DshRestoreError("truncated zstd block payload", "unparseable");
        if (last === 1) break;
    }
    if (checksum === 1) p += 4;
    if (p > buffer.length) throw new DshRestoreError("truncated zstd frame checksum", "unparseable");
    return p - offset;
}

function parseEvents(text: string, where: string): DshSessionEvent[] {
    const events: DshSessionEvent[] = [];
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        let event: unknown;
        try {
            event = JSON.parse(trimmed);
        } catch {
            throw new DshRestoreError(`${where} is not JSON — refusing to touch a damaged log`, "unparseable");
        }
        if (event === null || typeof event !== "object" || Array.isArray(event)) {
            throw new DshRestoreError(`${where} is not a JSON object`, "unparseable");
        }
        events.push(event as DshSessionEvent);
    }
    return events;
}

/** Split a session log into records. Accepts plain JSONL and the
 *  concatenated-zstd live format (one or more events per frame). */
export function readDshSessionRecords(buffer: Buffer): DshSessionRecord[] {
    const records: DshSessionRecord[] = [];
    if (isZstd(buffer)) {
        let offset = 0;
        while (offset < buffer.length) {
            const len = zstdFrameLength(buffer, offset);
            const frame = buffer.subarray(offset, offset + len);
            let text: string;
            try {
                text = zstdDecompressSync(frame).toString("utf8");
            } catch {
                throw new DshRestoreError(`zstd frame at byte ${offset} does not decompress`, "unparseable");
            }
            records.push({ start: offset, end: offset + len, events: parseEvents(text, `zstd frame at byte ${offset}`) });
            offset += len;
        }
        return records;
    }
    let start = 0;
    for (let i = 0; i <= buffer.length; i++) {
        if (i < buffer.length && buffer[i] !== 0x0a) continue;
        records.push({ start, end: i, events: parseEvents(buffer.subarray(start, i).toString("utf8"), `record at byte ${start}`) });
        start = i + 1;
    }
    return records.filter((r) => r.events.length > 0);
}

export interface DshRestorePlan {
    records: DshSessionRecord[];
    dropSeqs: Set<number>;
    shadowedSeqs: Set<number>;
    shadowedTokens: number;
    report: Omit<DshRestoreReport, "keptBytes">;
}

/** Decide which events survive. Pure: no I/O, no mutation of the input. */
export function planDshRestore(records: readonly DshSessionRecord[], opts?: { allowGaps?: boolean }): DshRestorePlan {
    const all = records.flatMap((r) => r.events);
    if (!all.some((e) => typeof e.type === "string" && e.type.startsWith("compaction/"))) {
        throw new DshRestoreError("no compaction events in this log — nothing to restore", "nothing-to-do");
    }
    const shadowedSeqs = new Set<number>();
    let shadowedTokens = 0;
    let prunedTokens = 0;
    for (const e of all) {
        const data = e.data as { shadowedSeqs?: unknown; shadowedTokenCount?: unknown } | undefined;
        const seqs = Array.isArray(data?.shadowedSeqs) ? data.shadowedSeqs : [];
        if (e.type === "compaction/prune") {
            for (const s of seqs) if (typeof s === "number") shadowedSeqs.add(s);
            if (typeof data?.shadowedTokenCount === "number") prunedTokens += data.shadowedTokenCount;
        } else if (e.type === "compaction/summary") {
            for (const s of seqs) if (typeof s === "number") shadowedSeqs.add(s);
            if (typeof data?.shadowedTokenCount === "number") shadowedTokens = Math.max(shadowedTokens, data.shadowedTokenCount);
        }
    }
    shadowedTokens = Math.max(shadowedTokens, prunedTokens);

    // The checkpoint message DSH injects right after the summary is generated
    // content, not history: drop it with the compaction events.
    const checkpointSeqs = new Set<number>();
    for (const e of all) {
        if (e.type !== "compaction/summary" || typeof e.seq !== "number") continue;
        const next = all.find((c) => c.seq === (e.seq as number) + 1 && c.type === "user/message");
        if (next && typeof next.seq === "number") checkpointSeqs.add(next.seq);
    }
    const dropEvent = (e: DshSessionEvent): boolean => {
        if (typeof e.type === "string" && DROP_TYPES.has(e.type)) return true;
        return typeof e.seq === "number" && checkpointSeqs.has(e.seq);
    };

    const keptEvents: DshSessionEvent[] = all.filter((e) => !dropEvent(e));
    const keptSeqs = new Set<number>();
    for (const e of keptEvents) if (typeof e.seq === "number") keptSeqs.add(e.seq);
    const missing = [...shadowedSeqs].filter((s) => !keptSeqs.has(s));
    const before = all.filter((e) => typeof e.type === "string" && MESSAGE_TYPES.has(e.type)).length;
    const after = keptEvents.filter((e) => typeof e.type === "string" && MESSAGE_TYPES.has(e.type)).length;
    if (missing.length > 0 && opts?.allowGaps !== true) {
        throw new DshRestoreError(
            `${missing.length} shadowed message(s) have no surviving event (e.g. seq ${missing.slice(0, 3).join(", ")}) — restoring would still lose data`,
            "unsafe",
        );
    }
    if (after !== before - checkpointSeqs.size) {
        throw new DshRestoreError(`message-event count would change beyond the dropped checkpoint (${before} -> ${after})`, "unsafe");
    }
    return {
        records: records as DshSessionRecord[],
        dropSeqs: new Set(checkpointSeqs),
        shadowedSeqs,
        shadowedTokens,
        report: {
            records: records.length,
            missingShadowed: missing.length,
            events: all.length,
            droppedCompactionEvents: all.filter((e) => typeof e.type === "string" && DROP_TYPES.has(e.type)).length,
            droppedCheckpointMessages: checkpointSeqs.size,
            shadowedSeqs: shadowedSeqs.size,
            shadowedTokens,
            messageEventsBefore: before,
            messageEventsAfter: after,
        },
    };
}

export interface DshRestoreResult {
    output: Buffer;
    report: DshRestoreReport;
    compressed: boolean;
}

/** Build the restored log. A frame none of whose events was dropped is copied
 *  verbatim; a frame that loses events is re-encoded from its survivors. */
export function restoreDshSessionBuffer(buffer: Buffer, opts?: { allowGaps?: boolean }): DshRestoreResult {
    const records = readDshSessionRecords(buffer);
    const plan = planDshRestore(records, opts);
    const compressed = isZstd(buffer);
    const parts: Buffer[] = [];
    for (const record of records) {
        const survivors = record.events.filter((e) => {
            if (typeof e.type === "string" && DROP_TYPES.has(e.type)) return false;
            return !(typeof e.seq === "number" && plan.dropSeqs.has(e.seq));
        });
        if (survivors.length === 0) continue;
        if (survivors.length === record.events.length) {
            parts.push(compressed ? buffer.subarray(record.start, record.end) : Buffer.from(`${survivors.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8"));
            continue;
        }
        const text = `${survivors.map((e) => JSON.stringify(e)).join("\n")}\n`;
        parts.push(compressed ? zstdCompressSync(Buffer.from(text, "utf8")) : Buffer.from(text, "utf8"));
    }
    const output = Buffer.concat(parts);
    return {
        output,
        compressed,
        report: { ...plan.report, keptBytes: output.length },
    };
}

export interface DshRestoreFileResult {
    input: string;
    outputPath: string | null;
    backupPath: string | null;
    report: DshRestoreReport;
    dryRun: boolean;
}

/** Resolve a session DIRECTORY to its log file (prefers the zstd live form). */
export function resolveSessionLogPath(target: string): string {
    if (!existsSync(target)) throw new DshRestoreError(`no such path: ${target}`, "io");
    if (statSync(target).isFile()) return target;
    const entries = readdirSync(target);
    const preferred = entries.find((e) => e.startsWith("session.v4.jsonl")) ?? entries.find((e) => e.endsWith(".jsonl") || e.endsWith(".jsonl.zstd"));
    if (preferred === undefined) throw new DshRestoreError(`no session log inside ${target}`, "io");
    return join(target, preferred);
}

/** Offline restore of one session file/directory. Never writes unless `write`
 *  is set; when it does, a timestamped backup is written first. */
export function runDshRestoreFile(target: string, opts?: { write?: boolean; dryRun?: boolean; allowGaps?: boolean }): DshRestoreFileResult {
    if (opts?.write === true) {
        // 2026-10-21: this path corrupted 10 DSH sessions (seq gap) and is now
        // unreachable by design — bili must never write the host's log.
        throw new DshRestoreError(
            "bili never writes DSH session logs: removing events leaves gaps in the append-only seq chain and the host refuses to open the session. Nothing was changed; the log is intact.",
            "io",
        );
    }
    const input = resolveSessionLogPath(target);
    const buffer = readFileSync(input);
    const { report } = restoreDshSessionBuffer(buffer, { allowGaps: opts?.allowGaps });
    return { input, outputPath: null, backupPath: null, report, dryRun: true };
}

/** Human-readable summary for the CLI. */
export function renderDshRestoreReport(result: DshRestoreFileResult): string {
    const r = result.report;
    const lines = [
        `session log: ${result.input}`,
        `events: ${r.events} -> ${r.events - r.droppedCompactionEvents - r.droppedCheckpointMessages} (dropped ${r.droppedCompactionEvents} compaction event(s) + ${r.droppedCheckpointMessages} injected checkpoint message(s))`,
        `un-shadowed: ${r.shadowedSeqs} message(s), ~${r.shadowedTokens} token(s)`,
        `message events: ${r.messageEventsBefore} -> ${r.messageEventsAfter} (the checkpoint is generated content, not history)`,
        ...(r.missingShadowed ? [`gaps: ${r.missingShadowed} shadowed message(s) are absent from the log itself — nothing can restore those; the rest is un-shadowed`] : []),
        result.dryRun ? "dry-run: nothing written (pass --write to restore in place)" : `written in place; backup: ${result.backupPath}`,
    ];
    return `${lines.join("\n")}\n`;
}

export function defaultRestoredPath(input: string): string {
    return join(dirname(input), `${basename(input)}.restored.jsonl`);
}

// ── Fleet restore (--all) ────────────────────────────────────────────────────
//
// Uninstalling bili hands DSH's native compaction back to the client, so the
// damage is not one session: every long session the user touched after the
// plugin left can carry its own `compaction/*` block. The single-file command
// therefore grows a fleet mode that scans the whole session tree and repairs
// what is safely repairable WITHOUT asking the user to hunt directories.
//
// Only sessions idle for at least RECENT_IDLE_MS are touched: a session DSH may
// still hold open is skipped (its next append/reload would race the rewrite),
// and it becomes eligible automatically once it has been quiet that long.

/** A session must be quiet this long before the fleet restore writes to it. */
const RESTORE_RECENT_IDLE_MS = 30 * 60 * 1000;

export interface DshRestoreScanEntry {
    path: string;
    /** "healthy" | "damaged" | "fixed" | "skipped-recent" | "error" */
    status: "healthy" | "damaged" | "fixed" | "skipped-recent" | "error";
    report?: DshRestoreReport;
    backupPath?: string | null;
    error?: string;
    idleMinutes: number;
}

export interface DshRestoreScanResult {
    root: string;
    scanned: number;
    healthy: number;
    damaged: number;
    fixed: number;
    skippedRecent: number;
    errors: number;
    entries: DshRestoreScanEntry[];
    dryRun: boolean;
}

/** Every session log under `root` (`.jsonl.zstd` live form preferred). */
export function findDshSessionLogs(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number): void => {
        if (depth > 4) return;
        let entries: string[];
        try {
            entries = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of entries) {
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
    if (!existsSync(root)) throw new DshRestoreError(`no such sessions root: ${root}`, "io");
    walk(root, 0);
    return out.sort();
}

/** Scan every session under `root`. READ-ONLY: `write` is refused outright
 *  (2026-10-21 the write path corrupted 10 sessions by leaving seq gaps). */
export function runDshRestoreAll(root: string, opts?: { write?: boolean; minIdleMs?: number; now?: number; allowGaps?: boolean }): DshRestoreScanResult {
    if (opts?.write === true) {
        throw new DshRestoreError(
            "bili never writes DSH session logs: removing events leaves gaps in the append-only seq chain and the host refuses to open the session. Nothing was changed; every log is intact.",
            "io",
        );
    }
    const write = false;
    const minIdleMs = opts?.minIdleMs ?? RESTORE_RECENT_IDLE_MS;
    const now = opts?.now ?? Date.now();
    const logs = findDshSessionLogs(root);
    const entries: DshRestoreScanEntry[] = [];
    for (const log of logs) {
        let idleMinutes = 0;
        try {
            idleMinutes = Math.round((now - statSync(log).mtimeMs) / 60000);
        } catch {
            idleMinutes = 0;
        }
        let buffer: Buffer;
        try {
            buffer = readFileSync(log);
        } catch (e) {
            entries.push({ path: log, status: "error", error: `cannot read: ${e instanceof Error ? e.message : String(e)}`, idleMinutes });
            continue;
        }
        let restored: ReturnType<typeof restoreDshSessionBuffer>;
        try {
            restored = restoreDshSessionBuffer(buffer, { allowGaps: opts?.allowGaps });
        } catch (e) {
            if (e instanceof DshRestoreError && e.code === "nothing-to-do") {
                entries.push({ path: log, status: "healthy", idleMinutes });
                continue;
            }
            entries.push({ path: log, status: "error", error: e instanceof Error ? e.message : String(e), idleMinutes });
            continue;
        }
        if (!write) {
            entries.push({ path: log, status: "damaged", report: restored.report, idleMinutes });
            continue;
        }
        if (idleMinutes * 60000 < minIdleMs) {
            entries.push({ path: log, status: "skipped-recent", report: restored.report, idleMinutes });
            continue;
        }
        const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
        const backupPath = `${log}.bak-${stamp}`;
        try {
            copyFileSync(log, backupPath);
            const tmpPath = `${log}.restore-tmp-${process.pid}`;
            writeFileSync(tmpPath, restored.output);
            renameSync(tmpPath, log);
        } catch (e) {
            entries.push({ path: log, status: "error", error: `write failed: ${e instanceof Error ? e.message : String(e)}`, idleMinutes });
            continue;
        }
        entries.push({ path: log, status: "fixed", report: restored.report, backupPath, idleMinutes });
    }
    return {
        root,
        scanned: entries.length,
        healthy: entries.filter((e) => e.status === "healthy").length,
        damaged: entries.filter((e) => e.status === "damaged").length,
        fixed: entries.filter((e) => e.status === "fixed").length,
        skippedRecent: entries.filter((e) => e.status === "skipped-recent").length,
        errors: entries.filter((e) => e.status === "error").length,
        entries,
        dryRun: !write,
    };
}

export function renderDshRestoreScanReport(result: DshRestoreScanResult): string {
    const lines = [
        `sessions root: ${result.root}`,
        `scanned ${result.scanned}: healthy ${result.healthy}, damaged ${result.damaged}, fixed ${result.fixed}, skipped-recent ${result.skippedRecent}, errors ${result.errors}`,
    ];
    for (const e of result.entries) {
        if (e.status === "healthy") continue;
        const gap = e.report?.missingShadowed ? `, ${e.report.missingShadowed} unrecoverable gap(s)` : "";
        const why = e.report ? `${e.report.shadowedSeqs} msg / ~${e.report.shadowedTokens} tok${gap}` : (e.error ?? "");
        lines.push(`  [${e.status}] ${e.path} (idle ${e.idleMinutes}m) — ${why}`);
    }
    if (result.dryRun) lines.push("dry-run: nothing written (pass --write to repair every eligible session)");
    return `${lines.join("\n")}\n`;
}
