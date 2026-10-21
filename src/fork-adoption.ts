import { anthropicToCore, googleToCore, openaiToCore } from "acp-kernel/wire";
import { BLOCKED_REF, STORED_PLACEHOLDER_MARKER, highestUsedIndex, type CompressionBlock, type CoreMessage } from "acp-kernel";
import { stripRawStage } from "./marker/engine.js";
import { normalizeResponsesMessageItems, sanitizeResponsesInputIds, dropWhitespaceResponsesMessages } from "./loop/adapter-responses.js";
import { responsesToCoreWithToolImages } from "./responses-tool-output.js";
import { replaceBiliCompactionItems } from "./codex-compact.js";
import { peekSession, markDirty, reserveRefsThrough, type Session } from "./session.js";
import { getStore } from "./persist.js";
import { adoptContentStore, cloneStoreForRefs, contentStoreOf } from "./store.js";
import type { WireProtocol } from "./util.js";

/**
 * Fork block-adoption (#629): when an anonymous client's history diverges in
 * the middle (edited message, regenerate-from-earlier, parallel branches),
 * prefix-affinity forks it into a NEW session with zero compression state and
 * the shared prefix's folded blocks are lost — the client replays (and the
 * proxy re-compresses) content the parent had already folded (#351: a 458K
 * token history resent raw). Adoption fixes the waste: on fork, copy the
 * parent's compression blocks whose source content is FULLY present in the
 * incoming request into the fresh session, so the fork starts where the
 * shared prefix ended instead of at zero.
 *
 * Adoptability is judged in raw-id SET semantics, not position math: a raw id
 * is a SHA-256 of the message identity (role+contentType+text+toolCallId+
 * toolName, wire/message-id.ts), so the same bytes produce the same id in
 * parent and child. A block is adoptable iff every id in its
 * effectiveMessageIds appears among the incoming request's core ids —
 * position-free, immune to subagent interleaving and reordering, and it
 * naturally rejects blocks that straddle the fork point (some source messages
 * beyond the fork are absent from the incoming). Tier blocks (T2/T3) carry
 * their children's messages in effectiveMessageIds, so a qualifying tier
 * block drags its whole child closure along; children are copied as inactive
 * records exactly as they stand in the parent (consumed-by-parent).
 *
 * Seeding is the disk-restore recipe (persist.ts buildSession → mergeState)
 * applied to a filtered subset: blocks + blockContents + the messageRefs
 * entries of the adopted ids (+ their tokenSnapshot), plus the CCR content-
 * store entries behind those refs (#1341): a ref-filtered independent clone,
 * because adopted block summaries cite their covered refs as retrievable and
 * the fork must be able to honor that (an empty store turns every cited ref
 * into a miss — or, until the kernel's placeholder-as-original fix lands,
 * into a fake hit once the child folds). The clone also covers refs cited by
 * placeholder-shaped incoming messages, whose originals are absent from the
 * view and nothing else can restore. The kernel's assignRefs cursor is
 * highestUsedIndex(map)+1, so seeded refs push fresh assignments ABOVE the
 * parent's ref space — within the new session a ref number still denotes
 * exactly one message, ever (the kernel's id-never-reused contract).
 * Deliberately NOT inherited: nudge state, the parent's own stats counters,
 * absorbed records, rules, terminalStreak (store byte counters are recomputed
 * from the child's own store via adoptContentStore).
 *
 * Copy-on-fork, not shared: the parent is deep-copied and untouched, so the
 * two branches never mutate each other's blocks. Adoption runs once, on the
 * fresh session's FIRST request (stats.requests === 0), before prepare*'s
 * processTurn assigns refs; afterwards the fork resolves via a normal prefix
 * match and never re-adopts.
 *
 * #1486 extends the same machinery to identified clients whose RESUME forks
 * a new session id (Claude Code --resume replays the full transcript under a
 * fresh UUID): maybeAdoptResume inherits ALL ref assignments whose raw ids
 * appear in the resumed transcript (seedAllRefs — the model's stale citations
 * span the whole history, not just folded blocks) plus, when the operator
 * enables it, the fully-present blocks. Refs are content-addressed (raw ids
 * are SHA-256 of message identity), so an inherited ref always denotes the
 * exact bytes the model saw: a stale citation resolves to its original
 * instead of mis-hitting a renumbered message, and fresh messages number
 * above the parent's ref space (kernel cursor semantics).
 */

/** Protocols whose prepare* pipeline this module mirrors for the id pass.
 *  All four wires are covered (#1853): responses and google log-skipped in
 *  v1, so identified resumes on those wires (codex over /v1/responses;
 *  gemini clients with a conversation header) inherited nothing but lineage
 *  and re-folded everything the parent had already folded. */
const SUPPORTED: ReadonlySet<WireProtocol> = new Set<WireProtocol>(["openai", "anthropic", "responses", "google"]);

export interface ForkAdoptionPlan {
    /** Blocks to seed (active adoptables + their tier children, inactive). */
    blocks: CompressionBlock[];
    /** blockIds in `blocks` (for blockContents lookup). */
    blockIds: Set<string>;
    /** Active (adoptable) block count — the headline number for logs. */
    adoptedActive: number;
    /** Sum of compressedTokens over the adopted ACTIVE blocks. */
    adoptedTokens: number;
    /** Active blocks rejected because part of their source is absent. */
    straddled: number;
    /** Highest ref string seeded, for logs. */
    maxRef: string;
    refs: { byRaw: Record<string, string>; byRef: Record<string, string> };
    tokenSnapshot: Record<string, number>;
    nextBlockId: number;
    nextRunId: number;
}

/** Core messages of the incoming request, computed through the SAME
 *  strip + convert pipeline as prepare* so the ids match what processTurn
 *  will see. Returns null for protocols without adoption support.
 *  #1853: the responses branch mirrors prepareResponses's pre-projection
 *  mutations IN ORDER (compaction-echo replacement → type stamping → id
 *  sanitize → whitespace drop → panel/marker strip → chain-carrier strip)
 *  before converting with the same tool-images wrapper prepare uses; google
 *  mirrors prepareGoogle (chain-carrier strip → googleToCore). Id parity
 *  with the kernel's processTurn input is the whole point: an id this pass
 *  misses drops a parent ref from the inheritance; an id it invents matches
 *  nothing (harmless superset). The plugin-mode mid-history sys/developer
 *  in-place marking (prepareResponses's `__bili_inplace_sysdev`) is
 *  deliberately NOT replicated: marked or hoisted, those items contribute
 *  no core message either way, so the id set is identical. */
export function incomingCoreMessages(protocol: WireProtocol, parsed: unknown): CoreMessage[] | null {
    if (!SUPPORTED.has(protocol)) return null;
    const clone = structuredClone(parsed) as Record<string, unknown>;
    if (protocol === "responses") {
        if (Array.isArray(clone.input)) {
            const { items, replaced, dropped } = replaceBiliCompactionItems(clone.input);
            if (replaced + dropped > 0) clone.input = items;
        }
        normalizeResponsesMessageItems(clone.input);
        sanitizeResponsesInputIds(clone.input);
        dropWhitespaceResponsesMessages(clone.input);
        stripRawStage(clone, "responses");
        return responsesToCoreWithToolImages(clone as Parameters<typeof responsesToCoreWithToolImages>[0]).msgs;
    }
    if (protocol === "google") {
        stripRawStage(clone, "google");
        return googleToCore(clone as Parameters<typeof googleToCore>[0]).msgs;
    }
    stripRawStage(clone, protocol);
    if (protocol === "openai") {
        return openaiToCore(clone as Parameters<typeof openaiToCore>[0]).msgs;
    }
    return anthropicToCore(clone as Parameters<typeof anthropicToCore>[0]).msgs;
}

/** Refs cited by placeholder-shaped incoming messages (#1341). Such a
 *  message's own bytes differ from the original's, so its raw id maps to no
 *  parent ref — the citation embedded in the placeholder is the only link
 *  back to the stored original, and arrival-time storing skips placeholder
 *  text by design, so nothing else can restore it. */
function citedPlaceholderRefs(msgs: CoreMessage[]): string[] {
    const refs: string[] = [];
    for (const m of msgs) {
        const text = m.text ?? "";
        const at = text.indexOf(STORED_PLACEHOLDER_MARKER);
        if (at < 0) continue;
        const mm = /#(m\d{4,})/.exec(text.slice(at));
        if (mm) refs.push(mm[1]);
    }
    return refs;
}

/** Decide which of the parent's blocks survive into the fork. Pure: reads
 *  the parent, returns a plan, mutates nothing.
 *  opts.seedAllRefs (#1486): seed EVERY ref whose raw id is present in the
 *  incoming request, not just the ones covered by adopted blocks — a resumed
 *  client cites refs across its whole history (its own earlier text), so the
 *  block-covered subset is far too small. Defaults false (existing callers
 *  keep their behavior).
 *  opts.includeBlocks: set false to plan refs only (no block adoption). */
export function planForkAdoption(
    parent: Session,
    incomingIds: Set<string>,
    opts?: { seedAllRefs?: boolean; includeBlocks?: boolean },
): ForkAdoptionPlan {
    const includeBlocks = opts?.includeBlocks ?? true;
    const byId = new Map<string, CompressionBlock>();
    for (const b of parent.state.blocks) byId.set(b.blockId, b);

    const active: CompressionBlock[] = [];
    let straddled = 0;
    if (includeBlocks) {
        for (const b of parent.state.blocks) {
            if (!b.active) continue;
            if (b.effectiveMessageIds.length === 0) continue;
            if (b.effectiveMessageIds.every((id) => incomingIds.has(id))) active.push(b);
            else straddled++;
        }
    }

    // Closure over directBlockIds: a tier block's children ride along as the
    // inactive records they are in the parent (their summaries back
    // decompress/acp_status history; they fold nothing on their own).
    const closure = new Set<string>();
    const queue = active.map((b) => b.blockId);
    while (queue.length > 0) {
        const id = queue.pop()!;
        if (closure.has(id)) continue;
        closure.add(id);
        for (const child of byId.get(id)?.directBlockIds ?? []) queue.push(child);
    }

    const blocks: CompressionBlock[] = [];
    const rawIds = new Set<string>();
    for (const id of closure) {
        const b = byId.get(id);
        if (!b) continue;
        blocks.push(structuredClone(b));
        for (const mid of b.effectiveMessageIds) rawIds.add(mid);
    }
    if (opts?.seedAllRefs) {
        for (const id of incomingIds) {
            if (parent.state.messageRefs.byRaw[id]) rawIds.add(id);
        }
    }

    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    const tokenSnapshot: Record<string, number> = {};
    let maxIndex = 0;
    let maxRef = "";
    for (const raw of rawIds) {
        const ref = parent.state.messageRefs.byRaw[raw];
        if (!ref) continue;
        byRaw[raw] = ref;
        // #2620: the kernel BLOCKED sentinel (protected tool messages) has no numeric
        // counterpart and is shared by many messages — byRef must never hold it.
        if (ref !== BLOCKED_REF) byRef[ref] = raw;
        const snap = parent.state.tokenSnapshot[ref];
        if (typeof snap === "number" && ref !== BLOCKED_REF) tokenSnapshot[ref] = snap;
        const idx = Number(ref.replace(/\D/g, "")) || 0;
        if (idx > maxIndex && ref !== BLOCKED_REF) {
            maxIndex = idx;
            maxRef = ref;
        }
    }

    return {
        blocks,
        blockIds: closure,
        adoptedActive: active.length,
        adoptedTokens: active.reduce((sum, b) => sum + b.compressedTokens, 0),
        straddled,
        maxRef,
        refs: { byRaw, byRef },
        tokenSnapshot,
        nextBlockId: parent.state.nextBlockId,
        nextRunId: parent.state.nextRunId,
    };
}

/** Seed a fresh fork session from the plan. Copy-on-fork: every value is a
 *  clone; the parent session is never touched. */
export function applyForkAdoption(session: Session, plan: ForkAdoptionPlan, parent: Session): void {
    for (const b of plan.blocks) {
        session.state.blocks.push(b);
        const content = parent.blockContents.get(b.blockId);
        if (content) session.blockContents.set(b.blockId, structuredClone(content));
    }
    for (const [raw, ref] of Object.entries(plan.refs.byRaw)) {
        if (!(raw in session.state.messageRefs.byRaw)) session.state.messageRefs.byRaw[raw] = ref;
        // #2620: byRef must never hold the kernel BLOCKED sentinel (shared by many
        // protected messages) — reserve byRaw only; mirrors planForkAdoption above.
        if (ref !== BLOCKED_REF && !(ref in session.state.messageRefs.byRef)) session.state.messageRefs.byRef[ref] = raw;
    }
    for (const [ref, tokens] of Object.entries(plan.tokenSnapshot)) {
        if (!(ref in session.state.tokenSnapshot)) session.state.tokenSnapshot[ref] = tokens;
    }
    session.state.nextBlockId = Math.max(session.state.nextBlockId, plan.nextBlockId);
    session.state.nextRunId = Math.max(session.state.nextRunId, plan.nextRunId);
    // Seeded refs only cover messages present in the child, so the cursor
    // would restart below refs the parent assigned to messages the child
    // dropped (its failed tail, a rewound branch) — and the model's older
    // text may still cite those. Reserve the parent's whole ref space.
    reserveRefsThrough(session, highestUsedIndex(parent.state.messageRefs));
    // #3769: carry the orphan-cleanup ledgers too — without this, the failed
    // compress pairs the pre-upgrade keep-two rotation hid (hiddenOrphanRefs)
    // or the fold-gated sweep already swept (sweptOrphanCallIds) would
    // RESURFACE on resume/fork replay, rewriting mid-history at full cache
    // cost. Both are monotonic id/ref sets; the hide pass re-records them
    // every turn, so the carry self-perpetuates afterwards.
    if (parent.state.hiddenOrphanRefs?.length) session.state.hiddenOrphanRefs = [...parent.state.hiddenOrphanRefs];
    if (parent.state.sweptOrphanCallIds?.length) session.state.sweptOrphanCallIds = [...parent.state.sweptOrphanCallIds];
    // #3939 ③: same carry for the truncation latch — resume/fork replay
    // re-sends the clipped messages; without the latch the first replayed
    // turn under a lower estimate re-exposes the full bytes (oscillation).
    if (parent.state.emergencyTruncateLatch?.length) {
        session.state.emergencyTruncateLatch = parent.state.emergencyTruncateLatch.map((e) => ({ ...e }));
    }
    // #3939 ②: same carry for the migration render deferral — a resumed/forked
    // session re-sends the same history; without the deferral the first replay
    // stamps migration tags mid-history (the #3805 byte flip, resurrected).
    if (parent.state.renderDeferredRefs?.length) {
        session.state.renderDeferredRefs = [...parent.state.renderDeferredRefs];
    }
    // #3939 ⑤: same carry for the view latch — a resumed session re-sends the
    // same history; a dropped latch would flip transform bytes on the first
    // replayed turn (crush re-derived, absorb hides landing late).
    if (parent.state.viewLatches) {
        session.state.viewLatches = Object.fromEntries(
            Object.entries(parent.state.viewLatches).map(([k, v]) => [k, { ...v }]),
        );
    }
    if (parent.state.viewLatchConfigDigest) {
        session.state.viewLatchConfigDigest = parent.state.viewLatchConfigDigest;
    }
    markDirty(session);
}

/** Server hook: on a fresh anonymous fork (via "new" + lineage "forked"),
 *  find the parent (memory first, then disk), measure what is adoptable, and
 *  seed the fresh session when enabled. Always logs the adoptable inventory —
 *  the measurement ework asked for in #629 — so operators can size the win
 *  before turning adoption on. */
export function maybeAdoptForkBlocks(args: {
    session: Session;
    parentId: string;
    protocol: WireProtocol;
    parsed: unknown;
    upstreamOrigin: string;
    enabled: boolean;
    log: (level: string, msg: string) => void;
}): void {
    const { session, parentId, protocol, parsed, upstreamOrigin, enabled, log } = args;
    const incomingMsgs = incomingCoreMessages(protocol, parsed);
    if (!incomingMsgs) {
        log("info", `[fork-adoption] ${protocol} anonymous fork of ${parentId}: no adoption support in v1, starting fresh (#629)`);
        return;
    }
    let parent = peekSession(parentId);
    if (!parent) parent = getStore().loadSync(parentId, { protocol, upstreamOrigin }) ?? undefined;
    if (!parent) {
        log("info", `[fork-adoption] fork parent ${parentId} not found (evicted and not persisted); starting fresh (#629)`);
        return;
    }
    const plan = planForkAdoption(parent, new Set(incomingMsgs.map((m) => m.id)));
    if (plan.adoptedActive === 0) {
        log("info", `[fork-adoption] fork of ${parentId}: no fully-present blocks to adopt (${plan.straddled} straddle the fork point); starting fresh (#629)`);
        return;
    }
    if (!enabled) {
        log("info", `[fork-adoption] fork of ${parentId}: parent has ${plan.adoptedActive} adoptable block(s) covering ~${plan.adoptedTokens} tokens; forkAdoption disabled, starting fresh (set forkAdoption: true or BILI_FORK_ADOPTION=1)`);
        return;
    }
    applyForkAdoption(session, plan, parent);
    log("info", `[fork-adoption] session ${session.id} adopted ${plan.adoptedActive} block(s) (~${plan.adoptedTokens} tokens, refs up to ${plan.maxRef || "n/a"}) from parent ${parentId} across fork (#629)`);
    // #1341: carry the originals behind the refs the fork now advertises as
    // retrievable — covered messages of the adopted blocks ∪ refs cited by
    // placeholder-shaped incoming messages (their originals left the view).
    const wanted = new Set([...Object.keys(plan.refs.byRef), ...citedPlaceholderRefs(incomingMsgs)]);
    const storeSlice = cloneStoreForRefs(contentStoreOf(parent), wanted);
    if (storeSlice) {
        adoptContentStore(session, storeSlice);
        const n = Object.keys(storeSlice.byRef).length;
        log("info", `[fork-adoption] session ${session.id} adopted ${n} CCR content-store entr${n === 1 ? "y" : "ies"} for the covered/cited refs from parent ${parentId} (#1341)`);
    }
}

/** Outcome of an inheritance attempt (#3351): lets the caller tell "blocks
 *  were adopted" apart from "refs-only / nothing," so the derived-blocks gate
 *  closes only on real block adoption — the same discipline the boot sweep
 *  (reconcileDerivedLineage) applies, not on ref-only seeding. */
interface AdoptionOutcome {
    adoptedActive: number;
    seededRefs: number;
}

/** #1486: copy-on-resume for an identified client whose resume forked a new
 *  session id (Claude Code --resume). The parent is resolved by the caller
 *  (memory first, then disk) via prefix-affinity's byte-exact full-history
 *  match. Inherits every ref assignment whose raw id is present in the
 *  resumed transcript plus, when blocksEnabled, the fully-present blocks —
 *  same copy-on-fork guarantees as #629: clones only, parent untouched, runs
 *  once on the fresh session's first request. */
export function maybeAdoptResume(args: {
    session: Session;
    parent: Session;
    sharedDepth: number;
    protocol: WireProtocol;
    parsed: unknown;
    upstreamOrigin: string;
    blocksEnabled: boolean;
    log: (level: string, msg: string) => void;
}): AdoptionOutcome {
    const { session, parent, sharedDepth, protocol, parsed, upstreamOrigin, blocksEnabled, log } = args;
    const incomingMsgs = incomingCoreMessages(protocol, parsed);
    if (!incomingMsgs) {
        log("info", `[resume-inheritance] ${session.id}: resumed ${parent.id} (${sharedDepth} shared msgs) but ${protocol} has no adoption support in v1; lineage recorded, refs/blocks not inherited (#1486)`);
        return { adoptedActive: 0, seededRefs: 0 };
    }
    const ids = new Set(incomingMsgs.map((m) => m.id));
    const plan = planForkAdoption(parent, ids, { seedAllRefs: true, includeBlocks: blocksEnabled });
    const seededRefs = Object.keys(plan.refs.byRaw).length;
    if (seededRefs === 0 && plan.adoptedActive === 0) {
        log("info", `[resume-inheritance] ${session.id}: resume of ${parent.id} had nothing to inherit (no overlapping refs${blocksEnabled ? " or fully-present blocks" : ""}); starting fresh (#1486)`);
        return { adoptedActive: 0, seededRefs: 0 };
    }
    applyForkAdoption(session, plan, parent);
    log(
        "info",
        `[resume-inheritance] ${session.id} resumed ${parent.id}: inherited ${seededRefs} ref(s) up to ${plan.maxRef || "n/a"}${plan.adoptedActive > 0 ? `, ${plan.adoptedActive} block(s) (~${plan.adoptedTokens} tokens)` : ""}; stale citations now resolve to their original messages (#1486)`,
    );
    const wanted = new Set([...Object.keys(plan.refs.byRef), ...citedPlaceholderRefs(incomingMsgs)]);
    const storeSlice = cloneStoreForRefs(contentStoreOf(parent), wanted);
    if (storeSlice) {
        adoptContentStore(session, storeSlice);
        const n = Object.keys(storeSlice.byRef).length;
        log("info", `[resume-inheritance] ${session.id} adopted ${n} CCR content-store entr${n === 1 ? "y" : "ies"} for the inherited/cited refs from parent ${parent.id} (#1341/#1486)`);
    }
    return { adoptedActive: plan.adoptedActive, seededRefs };
}

/** #2807: the derived (plugin-register) fork link previously recorded
 *  lineage only and fell back to read-only decompress/search_context — a
 *  replay-fork child that missed the byte-exact prefix match (timestamp
 *  drift, a re-decorated tail, a protocol switch) re-sent the whole raw
 *  history while the parent's fold ledger sat on disk. Adopt the parent's
 *  fully-present blocks by message-id intersection at link time — the same
 *  copy-on-fork seeding maybeAdoptResume runs for the strong path, minus the
 *  byte-prefix requirement. The call lands once per session (handle.ts gates
 *  it on derivedFromSessionId === undefined); the derivedBlocksAdopted marker
 *  it sets gates the BOOT reconcile, and since #3351 it is set only when blocks
 *  were actually adopted (mirroring reconcileDerivedLineage), so a young parent
 *  with no folds yet keeps the door open for a later retry. Gated on
 *  resumeInheritance, NOT forkAdoption: this is an identified fork
 *  (the parent came from the plugin register), same class as the strong
 *  path; #1834/#629 reserve forkAdoption for anonymous forks, and answering
 *  to two different switches left the weak path dark while the boot-time
 *  reconcile (below) still adopted. */
export function maybeAdoptDerivedFork(args: {
    session: Session;
    parent: Session;
    protocol: WireProtocol;
    parsed: unknown;
    upstreamOrigin: string;
    enabled: boolean;
    log: (level: string, msg: string) => void;
}): void {
    const { session, parent, protocol, parsed, upstreamOrigin, enabled, log } = args;
    if (!enabled || session.metadata.derivedBlocksAdopted === true) return;
    try {
        const outcome = maybeAdoptResume({ session, parent, sharedDepth: 0, protocol, parsed, upstreamOrigin, blocksEnabled: true, log });
        if (outcome.adoptedActive > 0) {
            session.metadata.derivedBlocksAdopted = true;
        } else {
            log("info", `[${session.id}] [derived] no blocks adopted from ${parent.id} yet (refs-only or none fully present); leaving the gate open so the boot reconcile can retry once the parent folds (#3351)`);
        }
    } catch (e) {
        log("warn", `[${session.id}] [derived] block adoption from ${parent.id} failed (${String(e)}); continuing fresh (#2807)`);
    }
}

/**
 * Lineage reconcile on boot (#2807 / #1333): the derived fork lineage is
 * persisted (`metadata.derivedFromSessionId`, written by handle.ts:1363) but
 * until now it was write-only — nothing ever read it back. Both adoption
 * paths need process-local state the proxy does not have across a restart:
 * the strong path scans `prefixAffinity.trackedChains` (in-memory), and the
 * weak path needs `derivedParent` from the plugin register table
 * (`pendingRegisters`, in-memory). A bili restart therefore leaves every
 * forked child holding a full raw history with zero blocks while its parent's
 * fold ledger sits on disk — which is how a session that upstream measured at
 * ~480K tokens got rejected as ~1.4M.
 *
 * So reconcile the lineage the other way round: after boot, for every session
 * that records a parent and still has no blocks, load the parent from disk and
 * re-run adoption by raw-id set (see planForkAdoption). This closes the same
 * gap as #2791 (anonymous pfa-* forks) without needing the identity chain.
 *
 * Gated by `resumeInheritance`, not `forkAdoption`: #1834 reserves
 * `forkAdoption` for anonymous forks, while this is an identified lineage
 * (the parent id came from the plugin register) and belongs with the
 * byte-prefix strong path, which is on by default.
 */
export function reconcileDerivedLineage(
    sessions: Session[],
    opts: { log: (level: string, msg: string) => void; adoptionEnabled: boolean },
): number {
    const { log, adoptionEnabled } = opts;
    if (!adoptionEnabled) return 0;
    let adopted = 0;
    for (const s of sessions) {
        // A closed gate must not consume the marker either, so a session stays
        // eligible if the operator turns adoption on and restarts.
        const parentId: unknown = s.metadata.derivedFromSessionId;
        if (typeof parentId !== "string") continue;
        if (parentId === s.id) continue;
        if (s.state.blocks.length > 0) continue;
        if (s.metadata.derivedBlocksAdopted === true) continue;

        let parent = peekSession(parentId);
        if (!parent) {
            parent = getStore().loadSync(parentId, {
                protocol: s.meta.protocol,
                upstreamOrigin: s.meta.upstreamOrigin,
            }) ?? undefined;
        }
        if (!parent) {
            // Evicted before it was persisted — or restored later. Leave the
            // marker unset and retry on the next boot rather than closing the
            // door on a parent that may reappear.
            log("info", `[lineage-reconcile] ${s.id} records parent ${parentId}, which is not on disk; will retry next boot`);
            continue;
        }
        if (parent.state.blocks.length === 0) {
            // Nothing to adopt now. Leave the marker unset: the parent may fold
            // later, and in a multi-hop lineage an intermediate parent may adopt
            // after this one was visited.
            log("info", `[lineage-reconcile] ${s.id}: parent ${parentId} has no blocks to adopt yet; will retry next boot`);
            continue;
        }

        const incomingIds = new Set(Object.keys(s.state.messageRefs.byRaw));
        if (incomingIds.size === 0) {
            // Leave the marker unset: this session has served no request yet, so
            // its first request is still the real reconciliation point (the weak
            // derived path adopts from the parent then). Closing the gate here
            // would defeat that path.
            log("info", `[lineage-reconcile] ${s.id}: no refs to match parent ${parentId} against; deferring to the first request`);
            continue;
        }

        try {
            const plan = planForkAdoption(parent, incomingIds, { seedAllRefs: true });
            if (plan.adoptedActive === 0) {
                // Nothing fully present. Do NOT set the marker: in a multi-hop
                // lineage P→C→G the sweep may not have reached C yet, and a
                // straddled block becomes fully-present once the child grows.
                // Retry on the next boot — the plan is cheap.
                log("info", `[lineage-reconcile] ${s.id}: parent ${parentId} has nothing fully present yet (${plan.straddled} block(s) straddle the fork); will retry next boot`);
                continue;
            }
            applyForkAdoption(s, plan, parent);
            const wanted = new Set(Object.keys(plan.refs.byRef));
            const storeSlice = cloneStoreForRefs(contentStoreOf(parent), wanted);
            if (storeSlice) {
                adoptContentStore(s, storeSlice);
            }
            s.metadata.derivedFrom ??= parent.id;
            s.metadata.derivedFromSessionId = parent.id;
            s.metadata.derivedBlocksAdopted = true;
            adopted++;
            log("info", `[lineage-reconcile] ${s.id} adopted ${plan.adoptedActive} block(s) (~${plan.adoptedTokens} tokens, ${plan.straddled} straddled) from parent ${parent.id} (#2807)`);
        } catch (e) {
            // Transient (a corrupt parent file): leave the marker unset so a
            // later boot can still try, but never let one bad session abort the
            // whole sweep.
            log("warn", `[lineage-reconcile] ${s.id}: adoption from parent ${parent.id} failed (${e instanceof Error ? e.message : String(e)}); continuing`);
        }
    }
    return adopted;
}

// ── Fold-state recovery from a sibling lane (#4046) ──────────────────────────
//
// A conversation can accumulate several LANES: the resolver keys state by
// (conversation id) + (`|sub:` persona/fork fingerprint, `|sub:task:` kind
// skeleton), and every model switch or system-prompt re-render that changes the
// fingerprint forks a NEW lane with zero compression state. Switching back then
// re-enters the RAW lane through a raw-continuing rung, so the request lands on
// whatever record sits at the raw key — in the incident that produced this
// module, a 15-ref/0-block husk — while the 86 folded blocks stayed under the
// sibling `|sub:` lane, written by the same conversation and never consulted.
// The client then resends its whole history raw: 1.29M tokens against a 1M
// window that no amount of summarization can close in one turn (fold coverage
// is ~5%/round against a ~1.8x overshoot), so the session 400s on every message.
//
// The recovery is the fork-adoption machinery applied across lanes instead of
// down a lineage: a block is adoptable iff every message id it covers is present
// in the incoming request (raw ids are content hashes, so the same bytes yield
// the same ids in every lane), which is exactly what a full-history replay
// provides and exactly why a lost fold ledger is recoverable without an LLM.
// Nothing is adopted when the current lane still has active blocks, when no
// sibling covers the replay, or on a lane the resolver owns for a subagent
// skeleton — the ledger is then simply rebuilt from raw, as today.

/** Most sibling lanes a single recovery will load. Cross-lane siblings are
 *  minted by model/persona switches, so a handful is already exceptional; the
 *  cap keeps a pathological tree from turning one request into a disk walk. */
const RECOVERY_MAX_DONORS = 8;
/** Below this many inbound messages the recovery never runs: each attempt parses
 *  up to RECOVERY_MAX_DONORS lane files synchronously (the handler is on the
 *  request path), and a replay that small fits any window without folds — the
 *  bounded retry below waits for a request big enough for the ledger to matter. */
const RECOVERY_MIN_INCOMING = 8;
/** How many times one lane may re-attempt the recovery after an attempt that
 *  adopted nothing. A single miss is NOT proof that nothing is recoverable: the
 *  donor may not have been saved yet, or that request may not have been the
 *  full replay (a tail-only probe covers fewer blocks than a whole transcript).
 *  Bounded, because each attempt parses up to RECOVERY_MAX_DONORS lane files. */
const RECOVERY_MAX_TRIES = 3;

/** The CONVERSATION a session id belongs to: the client's own id, i.e. the text
 *  before the resolver's first `|` suffix. Pure. */
export function conversationOf(sessionId: string): string {
    const i = sessionId.indexOf("|");
    return i <= 0 ? sessionId : sessionId.slice(0, i);
}

/** Lane ids of the same conversation other than `sessionId`. The raw lane
 *  itself is not a sibling of its `|sub:` lanes, and lanes of a different
 *  conversation are never candidates. Pure and order-preserving (the caller
 *  bounds the scan). */
export function siblingLaneIds(known: Iterable<string>, sessionId: string): string[] {
    const base = conversationOf(sessionId);
    const persona: string[] = [];
    const other: string[] = [];
    for (const id of known) {
        if (id === sessionId || !id.includes("|")) continue;
        if (conversationOf(id) !== base) continue;
        // A task skeleton lane carries extracted memory, never a conversation
        // transcript — its blocks can not cover a replay's refs.
        if (id.includes("|sub:task:")) continue;
        if (id.includes("|sub:")) persona.push(id);
        else other.push(id);
    }
    // Deterministic order (the store's enumeration order is not): persona-fork
    // lanes first, then any other suffixed lane of the same conversation.
    persona.sort();
    other.sort();
    return [...persona, ...other];
}

/** Pick the donor whose plan carries the most folded history. Pure; ties go to
 *  the larger token total (a block count alone cannot tell a 30K-token fold
 *  from a 300-token one). */
export function pickFoldDonor<T extends { plan: { adoptedActive: number; adoptedTokens: number } }>(
    candidates: readonly T[],
): T | null {
    let best: T | null = null;
    for (const c of candidates) {
        if (best === null) {
            best = c;
            continue;
        }
        if (c.plan.adoptedActive > best.plan.adoptedActive) {
            best = c;
            continue;
        }
        if (c.plan.adoptedActive === best.plan.adoptedActive && c.plan.adoptedTokens > best.plan.adoptedTokens) best = c;
    }
    return best;
}

export interface FoldRecoveryDeps {
    /** Every session id the store can enumerate (replica index, else tree). */
    knownSessionIds: () => string[];
    /** Load a lane by id from disk (null when it cannot be resolved). */
    loadSession: (id: string) => Session | null;
    /** In-memory lane, when resident (avoids a disk read). */
    peek: (id: string) => Session | undefined;
}

/** Outcome of one recovery attempt: how many blocks were adopted, from which
 *  lane, and how many sibling lanes were examined. */
export interface FoldRecoveryResult {
    adopted: number;
    donorId: string | null;
    scanned: number;
}

/** Why this plan cannot be adopted into `session` without corrupting its ref
 *  space, or null when it is safe. The plan seeds `byRaw`/`byRef` numbers that
 *  came from the DONOR lane, while the target lane may already have bound some
 *  of those numbers to its own messages; `assignRefs` never corrects an
 *  existing mapping, so a number bound to a DIFFERENT message would silently
 *  retarget compress/decompress at the wrong live message — worse than the lost
 *  ledger this recovery exists to repair. All-or-nothing: any disagreement
 *  refuses the whole plan (the lane then folds from scratch, as today). */
export function foldRecoveryConflict(session: Session, plan: ForkAdoptionPlan): string | null {
    for (const [raw, ref] of Object.entries(plan.refs.byRaw)) {
        const haveRef = session.state.messageRefs.byRaw[raw];
        if (haveRef !== undefined && haveRef !== ref) {
            return `message ${raw} already carries ${haveRef} (donor numbered it ${ref})`;
        }
        if (ref !== BLOCKED_REF) {
            const haveRaw = session.state.messageRefs.byRef[ref];
            if (haveRaw !== undefined && haveRaw !== raw) {
                return `ref ${ref} already maps to ${haveRaw} (donor mapped it to ${raw})`;
            }
        }
    }
    const existing = new Set(session.state.blocks.map((b) => b.blockId));
    for (const b of plan.blocks) {
        if (existing.has(b.blockId)) return `block ${b.blockId} already exists in this lane`;
    }
    return null;
}

/** Adopt a sibling lane's fold ledger into `session` when the lane lost it.
 *  Returns what it did so callers/tests can assert; never throws on a donor
 *  that fails to load (a corrupt sibling must not fail the request). */
export function recoverFoldsFromSibling(args: {
    session: Session;
    incomingIds: ReadonlySet<string>;
    deps: FoldRecoveryDeps;
    log: (level: string, msg: string) => void;
    maxDonors?: number;
}): FoldRecoveryResult {
    const { session, incomingIds, deps, log } = args;
    const maxDonors = args.maxDonors ?? RECOVERY_MAX_DONORS;
    const nothing = { adopted: 0, donorId: null, scanned: 0 };
    // The lane still owns fold state: nothing was lost, nothing to recover.
    if (session.state.blocks.some((b) => b.active)) return nothing;
    let known: string[];
    try {
        known = deps.knownSessionIds();
    } catch {
        return nothing;
    }
    const siblings = siblingLaneIds(known, session.id).slice(0, maxDonors);
    if (siblings.length === 0) return nothing;
    const candidates: Array<{ plan: ForkAdoptionPlan; donor: Session }> = [];
    const targetProtocol = session.meta.protocol;
    for (const id of siblings) {
        try {
            const donor = deps.peek(id) ?? deps.loadSession(id);
            if (!donor) continue;
            // Refs, message ids and the block sidecar store are all
            // protocol-shaped (a block's hidden prose only resolves through the
            // protocol that wrote it). A cross-protocol sibling cannot be
            // adopted: skip it instead of adopting half a ledger.
            if (targetProtocol && donor.meta.protocol && donor.meta.protocol !== targetProtocol) {
                log(
                    "warn",
                    `[fold-recovery] ${session.id}: skipping sibling lane ${id} — its ledger was written for protocol ${donor.meta.protocol}, this lane speaks ${targetProtocol}`,
                );
                continue;
            }
            if (!donor.state.blocks.some((b) => b.active)) continue;
            const plan = planForkAdoption(donor, incomingIds as Set<string>, { seedAllRefs: true });
            if (plan.adoptedActive === 0) continue;
            const conflict = foldRecoveryConflict(session, plan);
            if (conflict !== null) {
                log("warn", `[fold-recovery] ${session.id}: refusing sibling lane ${id} — ${conflict} (#4046 ref-space safety)`);
                continue;
            }
            candidates.push({ plan, donor });
        } catch {
            // A corrupt or half-written sibling is not a reason to fail the
            // request this lane is trying to serve.
            continue;
        }
    }
    const best = pickFoldDonor(candidates);
    if (!best) {
        log(
            "warn",
            `[fold-recovery] ${session.id}: lane has no active fold state and none of ${siblings.length} sibling lane(s) covers this replay — folding from scratch`,
        );
        return { adopted: 0, donorId: null, scanned: siblings.length };
    }
    applyForkAdoption(session, best.plan, best.donor);
    // Same CCR carry as a fork: the adopted summaries cite refs as retrievable,
    // so the originals behind them must come along or every citation misses.
    const wanted = new Set(Object.keys(best.plan.refs.byRef));
    const storeSlice = cloneStoreForRefs(contentStoreOf(best.donor), wanted);
    if (storeSlice) adoptContentStore(session, storeSlice);
    session.metadata.foldRecoveredFrom = best.donor.id;
    session.metadata.foldRecoveredBlocks = best.plan.adoptedActive;
    markDirty(session);
    log(
        "info",
        `[fold-recovery] ${session.id}: adopted ${best.plan.adoptedActive} fold block(s) (~${best.plan.adoptedTokens} tok, ${best.plan.straddled} straddled) from sibling lane ${best.donor.id} — the replay would otherwise have re-sent its whole history unfolded`,
    );
    return { adopted: best.plan.adoptedActive, donorId: best.donor.id, scanned: siblings.length };
}

/** Server hook: run the recovery once per lane, before prepare* assigns refs,
 *  when the lane has no active blocks and the request is a replay big enough to
 *  hold a fold ledger. Cheap when the lane is healthy (one predicate) and when
 *  nothing is recoverable (one log line). */
export function maybeRecoverFoldsFromSibling(args: {
    session: Session;
    protocol: WireProtocol;
    parsed: unknown;
    upstreamOrigin: string;
    log: (level: string, msg: string) => void;
}): void {
    const { session, protocol, parsed, upstreamOrigin, log } = args;
    if (!SUPPORTED.has(protocol)) return;
    // A subagent skeleton lane has no history of its own to recover.
    if (session.id.includes("|sub:task:")) return;
    if (session.metadata.foldRecoveryTried === true) return;
    const tries = typeof session.metadata.foldRecoveryTries === "number" ? session.metadata.foldRecoveryTries : 0;
    if (tries >= RECOVERY_MAX_TRIES) return;
    if (session.state.blocks.some((b) => b.active)) return;
    // A lane that has never served a request is not a replay: skipping it keeps
    // every brand-new conversation off the discovery path (a session that DID
    // serve and then lost its ledger is exactly the incident shape). Resumed
    // transcripts under a fresh id keep their own inheritance path (#1486).
    if ((session.stats.requests ?? 0) <= 0) return;
    const incoming = incomingCoreMessages(protocol, parsed);
    if (!incoming || incoming.length < RECOVERY_MIN_INCOMING) return;
    session.metadata.foldRecoveryTries = tries + 1;
    const store = getStore();
    let result: FoldRecoveryResult = { adopted: 0, donorId: null, scanned: 0 };
    try {
        result = recoverFoldsFromSibling({
            session,
            incomingIds: new Set(incoming.map((m) => m.id)),
            deps: {
                knownSessionIds: () => store.knownSessionIds(),
                loadSession: (id) => store.loadSync(id, { protocol, upstreamOrigin }),
                peek: (id) => peekSession(id),
            },
            log,
        });
    } catch (e) {
        // Recovery is an availability aid, never a reason to fail the request
        // this lane is trying to serve.
        log("warn", `[fold-recovery] ${session.id}: recovery threw (${e instanceof Error ? e.message : String(e)}) — folding from scratch`);
    }
    // A successful adoption is permanent (the healthy-lane predicate above now
    // short-circuits). A miss is retried, bounded: the donor may not have been
    // saved yet, and a tail-only replay does not prove that the full transcript
    // would not cover.
    if (result.adopted > 0) session.metadata.foldRecoveryTried = true;
}
