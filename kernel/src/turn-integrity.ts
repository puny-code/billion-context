import type { CoreMessage } from "./types.js";

function isAssistantAct(msg: CoreMessage): boolean {
  return (
    msg.role === "assistant" &&
    (msg.contentType === "text" || msg.contentType === "tool-call")
  );
}

/**
 * Atomic turn groups for compression integrity (#684).
 *
 * A turn is a reasoning run, the assistant text/tool-call burst that follows
 * it, and every tool-result paired (by toolCallId) to the burst's calls.
 * Strict-echo thinking providers (DeepSeek: "The `reasoning_content` in the
 * thinking mode must be passed back to the API") reject a rebuilt request
 * whose assistant tool-call turn survives without its reasoning, and every
 * OpenAI-wire provider rejects a result whose call is gone. Turns are
 * therefore atomic for folding: all members fold together, or none do.
 *
 * Grouping is adjacency-based, mirroring {@link adjustBoundariesForReasoningPairs}:
 * a reasoning run pairs with the assistant burst immediately following it.
 * Bursts without a preceding reasoning run still group with their sibling
 * calls and results. Messages belonging to no turn (user messages, system,
 * orphan reasoning, summaries) get no group — they carry no pairing
 * constraint. Groups are disjoint.
 *
 * @returns disjoint member-id arrays; a message appears in at most one group.
 */
export function computeTurnGroups(messages: CoreMessage[]): string[][] {
  const resultIdByCallId = new Map<string, string>();
  for (const msg of messages) {
    if (
      msg.contentType === "tool-result" &&
      typeof msg.toolCallId === "string" &&
      msg.id
    ) {
      if (!resultIdByCallId.has(msg.toolCallId))
        resultIdByCallId.set(msg.toolCallId, msg.id);
    }
  }

  const grouped = new Set<string>();
  const groups: string[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (!msg.id || grouped.has(msg.id)) continue;
    if (!(msg.contentType === "reasoning" || isAssistantAct(msg))) continue;

    let reasoningStart = i;
    if (msg.contentType === "reasoning") {
      while (
        reasoningStart > 0 &&
        messages[reasoningStart - 1]!.contentType === "reasoning"
      ) {
        reasoningStart--;
      }
    } else {
      let s = i;
      while (s > 0 && isAssistantAct(messages[s - 1]!)) s--;
      reasoningStart = s;
      while (
        reasoningStart > 0 &&
        messages[reasoningStart - 1]!.contentType === "reasoning"
      ) {
        reasoningStart--;
      }
    }
    const burstStart = (() => {
      let s = reasoningStart;
      while (s < messages.length && messages[s]!.contentType === "reasoning")
        s++;
      return s;
    })();
    if (
      burstStart >= messages.length ||
      !isAssistantAct(messages[burstStart]!)
    ) {
      // Orphan reasoning run (no companion burst): no pairing constraint.
      continue;
    }
    let burstEnd = burstStart;
    while (
      burstEnd + 1 < messages.length &&
      isAssistantAct(messages[burstEnd + 1]!)
    ) {
      burstEnd++;
    }

    const members = new Set<string>();
    for (let k = reasoningStart; k <= burstEnd; k++) {
      const m = messages[k]!;
      if (!m.id) continue;
      members.add(m.id);
      if (
        m.role === "assistant" &&
        m.contentType === "tool-call" &&
        typeof m.toolCallId === "string"
      ) {
        const rid = resultIdByCallId.get(m.toolCallId);
        if (rid) members.add(rid);
      }
    }
    for (const id of members) grouped.add(id);
    groups.push([...members]);
  }
  return groups;
}

/** Which folded ids the rebuild cannot keep folded, and how many turns and
 *  call/result pairs that covers. */
export interface IntegrityWithdrawals {
  withdrawn: Set<string>;
  splitTurnCount: number;
  splitPairCount: number;
}

/**
 * Turn-invariant structures the withdrawal fixed point reads. Built once per
 * unchanged message array (`buildIntegrityIndex`) so a per-range screen does
 * not rebuild them for every candidate range. Only `remaining`/`withdrawn`
 * vary between calls; everything in here is a pure function of `messages`.
 */
export interface IntegrityIndex {
  reasoningIds: Set<string>;
  callIds: Set<string>;
  callIdByMessageId: Map<string, string>;
  resultIdByCallId: Map<string, string>;
  groups: string[][];
  /** member id → indices of the turn groups containing it (groups are
   *  normally disjoint; duplicate toolCallIds can pull one id into two). */
  groupIndexByMemberId: Map<string, number[]>;
  /** message id → first position in `messages` (stable ordering proxy). */
  messageIndexById: Map<string, number>;
  /** toolCallId → assistant tool-call message ids carrying it, in message order. */
  callMessageIdsByCallId: Map<string, string[]>;
  /** tool-result message id → its toolCallId. */
  toolCallIdByResultMessageId: Map<string, string>;
}

/** Build the turn-invariant index for `messages`. O(messages). */
export function buildIntegrityIndex(messages: CoreMessage[]): IntegrityIndex {
  const reasoningIds = new Set<string>();
  const callIds = new Set<string>();
  const callIdByMessageId = new Map<string, string>();
  const resultIdByCallId = new Map<string, string>();
  const messageIndexById = new Map<string, number>();
  const callMessageIdsByCallId = new Map<string, string[]>();
  const toolCallIdByResultMessageId = new Map<string, string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (!m.id) continue;
    if (!messageIndexById.has(m.id)) messageIndexById.set(m.id, i);
    if (m.contentType === "reasoning") reasoningIds.add(m.id);
    if (m.role === "assistant" && m.contentType === "tool-call") {
      callIds.add(m.id);
      if (typeof m.toolCallId === "string") {
        callIdByMessageId.set(m.id, m.toolCallId);
        const list = callMessageIdsByCallId.get(m.toolCallId);
        if (list) list.push(m.id);
        else callMessageIdsByCallId.set(m.toolCallId, [m.id]);
      }
    }
    if (m.contentType === "tool-result" && typeof m.toolCallId === "string") {
      if (!resultIdByCallId.has(m.toolCallId)) {
        resultIdByCallId.set(m.toolCallId, m.id);
      }
      toolCallIdByResultMessageId.set(m.id, m.toolCallId);
    }
  }
  const groups = computeTurnGroups(messages);
  const groupIndexByMemberId = new Map<string, number[]>();
  groups.forEach((group, index) => {
    for (const id of group) {
      const list = groupIndexByMemberId.get(id);
      if (list) list.push(index);
      else groupIndexByMemberId.set(id, [index]);
    }
  });
  return {
    reasoningIds,
    callIds,
    callIdByMessageId,
    resultIdByCallId,
    groups,
    groupIndexByMemberId,
    messageIndexById,
    callMessageIdsByCallId,
    toolCallIdByResultMessageId,
  };
}

/**
 * Fold-integrity gate (#684): given the ids a fold removes from the visible
 * stream, return the ids that must stay visible instead.
 *
 *   - INV1 — a kept assistant tool-call must keep its reasoning run, so a turn
 *     whose reasoning folds while a call of the same turn stays visible is
 *     withdrawn wholesale (all members stay visible).
 *   - INV2 — a tool-call and its tool-result are one exchange: a pair the fold
 *     would split is withdrawn together.
 *
 * The two invariants feed each other. Withdrawing a call for INV2 leaves a turn
 * whose reasoning still folds while its call now stays visible — exactly the
 * INV1 split — and withdrawing a turn for INV1 can strand a result whose call
 * survived outside the turn. One pass in a fixed order misses both, so the gate
 * repeats until nothing changes; a turn or pair is acted on once and reported
 * once.
 *
 * The reverse direction stays allowed (#564): reasoning and text may stay
 * visible while the call and its result fold, since that leaves a valid stream.
 *
 * `index` is an optional caller-owned `buildIntegrityIndex(messages)` for the
 * same array: pass it when screening many ranges against one unchanged array
 * and the fixed point only has to visit the turns/pairs the fold actually
 * touches. Omitting it runs the historical full scan — identical results.
 *
 * Coverage is not "kept". An id in `invisibleIds` is already hidden by an
 * active block: it neither counts as folding nor as kept-visible. A covered
 * tool-call therefore cannot strand its turn's reasoning — without this, a
 * #564 reverse split (call+result inside an existing block, reasoning+text
 * visible) withdraws the stranded pair wholesale FOREVER: they leave no gap a
 * range can span, so every later fold reclaims only everything else and the
 * residue grows monotonically until nothing left is big enough to fold
 * (billion-context#5531). Omit the parameter for the legacy model where
 * everything not folded reads as visible.
 */
export function computeIntegrityWithdrawals(
  messages: CoreMessage[],
  foldedIds: ReadonlySet<string>,
  index?: IntegrityIndex,
  invisibleIds?: ReadonlySet<string>,
): IntegrityWithdrawals {
  if (index !== undefined) {
    return computeWithdrawalsIndexed(index, foldedIds, invisibleIds);
  }
  const remaining = new Set(foldedIds);
  const withdrawn = new Set<string>();
  const handledTurns = new Set<number>();
  const handledPairs = new Set<string>();

  const reasoningIds = new Set<string>();
  const callIds = new Set<string>();
  const callIdByMessageId = new Map<string, string>();
  const resultIdByCallId = new Map<string, string>();
  for (const m of messages) {
    if (!m.id) continue;
    if (m.contentType === "reasoning") reasoningIds.add(m.id);
    if (m.role === "assistant" && m.contentType === "tool-call") {
      callIds.add(m.id);
      if (typeof m.toolCallId === "string") {
        callIdByMessageId.set(m.id, m.toolCallId);
      }
    }
    if (m.contentType === "tool-result" && typeof m.toolCallId === "string") {
      if (!resultIdByCallId.has(m.toolCallId)) {
        resultIdByCallId.set(m.toolCallId, m.id);
      }
    }
  }

  const groups = computeTurnGroups(messages);
  let changed = true;
  while (changed) {
    changed = false;

    for (let g = 0; g < groups.length; g++) {
      if (handledTurns.has(g)) continue;
      const group = groups[g]!;
      const foldHasReasoning = group.some(
        (id) => remaining.has(id) && reasoningIds.has(id),
      );
      if (!foldHasReasoning) continue;
      const keptHasCall = group.some(
        (id) =>
          !remaining.has(id) &&
          callIds.has(id) &&
          !invisibleIds?.has(id),
      );
      if (!keptHasCall) continue;
      handledTurns.add(g);
      for (const id of group) {
        remaining.delete(id);
        withdrawn.add(id);
      }
      changed = true;
    }

    for (const m of messages) {
      if (!m.id || !callIds.has(m.id)) continue;
      const callId = callIdByMessageId.get(m.id);
      if (callId === undefined || handledPairs.has(callId)) continue;
      const resultId = resultIdByCallId.get(callId);
      if (resultId === undefined) continue;
      if (remaining.has(m.id) === remaining.has(resultId)) continue;
      handledPairs.add(callId);
      remaining.delete(m.id);
      remaining.delete(resultId);
      withdrawn.add(m.id);
      withdrawn.add(resultId);
      changed = true;
    }
  }

  return {
    withdrawn,
    splitTurnCount: handledTurns.size,
    splitPairCount: handledPairs.size,
  };
}

/**
 * Same fixed point as the full scan above, driven from a prebuilt
 * `IntegrityIndex` and visiting ONLY the turns/pairs this fold can touch.
 *
 * Why the restriction is exact (not a heuristic): both passes only ever
 * DELETE from `remaining`, so `remaining ⊆ foldedIds` holds for the whole run.
 * A turn is withdrawn only when `foldHasReasoning` — some member is in
 * `remaining` — and a pair only when exactly one of its two halves is in
 * `remaining`. Both therefore need a member of the ORIGINAL `foldedIds`. Every
 * other turn/pair can only ever hit a `continue`, mutating nothing, and a pass
 * that mutates nothing cannot change the order in which the surviving ones
 * mutate `remaining` — so the visited subset converges to the same fixed
 * point, with the same `splitTurnCount` / `splitPairCount`.
 *
 * #5531 keeps that argument: `invisibleIds` only refines the KEPT-side test of
 * the turn pass, so it can turn a would-be withdrawal into a `continue` but
 * never introduces a withdrawal outside the candidate set (a turn still needs
 * a folded member to be visited at all).
 */
function computeWithdrawalsIndexed(
  index: IntegrityIndex,
  foldedIds: ReadonlySet<string>,
  invisibleIds?: ReadonlySet<string>,
): IntegrityWithdrawals {
  const remaining = new Set(foldedIds);
  const withdrawn = new Set<string>();
  const handledTurns = new Set<number>();
  const handledPairs = new Set<string>();

  // Candidate turns: groups holding a folded id. Candidate call messages: a
  // tool-call message that is itself folded, or every call message sharing the
  // callId of a folded tool-result (the pair pass is keyed by callId but walks
  // call MESSAGES in array order, so a duplicate call id must keep its place).
  const candidateGroups = new Set<number>();
  const candidateCallMessageIds = new Set<string>();
  for (const id of foldedIds) {
    for (const groupIndex of index.groupIndexByMemberId.get(id) ?? []) {
      candidateGroups.add(groupIndex);
    }
    if (index.callIdByMessageId.has(id)) candidateCallMessageIds.add(id);
    const resultCallId = index.toolCallIdByResultMessageId.get(id);
    if (resultCallId !== undefined) {
      for (const callMessageId of index.callMessageIdsByCallId.get(
        resultCallId,
      ) ?? []) {
        candidateCallMessageIds.add(callMessageId);
      }
    }
  }
  const groupOrder = [...candidateGroups].sort((a, b) => a - b);
  const callOrder = [...candidateCallMessageIds]
    .map((messageId) => ({
      messageId,
      at: index.messageIndexById.get(messageId) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.at - b.at);

  let changed = true;
  while (changed) {
    changed = false;

    for (const g of groupOrder) {
      if (handledTurns.has(g)) continue;
      const group = index.groups[g]!;
      const foldHasReasoning = group.some(
        (id) => remaining.has(id) && index.reasoningIds.has(id),
      );
      if (!foldHasReasoning) continue;
      const keptHasCall = group.some(
        (id) => !remaining.has(id) && index.callIds.has(id) && !invisibleIds?.has(id),
      );
      if (!keptHasCall) continue;
      handledTurns.add(g);
      for (const id of group) {
        remaining.delete(id);
        withdrawn.add(id);
      }
      changed = true;
    }

    for (const { messageId } of callOrder) {
      const callId = index.callIdByMessageId.get(messageId);
      if (callId === undefined || handledPairs.has(callId)) continue;
      const resultId = index.resultIdByCallId.get(callId);
      if (resultId === undefined) continue;
      if (remaining.has(messageId) === remaining.has(resultId)) continue;
      handledPairs.add(callId);
      remaining.delete(messageId);
      remaining.delete(resultId);
      withdrawn.add(messageId);
      withdrawn.add(resultId);
      changed = true;
    }
  }

  return {
    withdrawn,
    splitTurnCount: handledTurns.size,
    splitPairCount: handledPairs.size,
  };
}
