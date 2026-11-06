// acp_history — the read side of "the host compacted it away, storage still
// has it". These tests pin the SIZE DISCIPLINE rather than the plumbing: a
// history tool that can dump 27 MiB into context is worse than no tool, so
// every case below asserts an upper bound on what one call can return.
import test from "node:test";
import assert from "node:assert/strict";
import { executeHistoryLookup, parseRefNum, readableMessageText, renderRange, snippetOf } from "../src/history-retrieval.ts";
import type { MessageRefContentRow, MessageTextSearchResult } from "../src/storage/store.ts";

const row = (refNum: number, content: string, role = "user", kind = "message"): MessageRefContentRow => ({ refNum, role, kind, content });
const hit = (seq: number, refNum: number, content: string, role = "assistant") => ({ seq, refNum, role, kind: "message", content, retired: false });
const found = (over: Partial<MessageTextSearchResult>): MessageTextSearchResult => ({ hits: [], scanned: 0, total: 0, capped: false, scannedTo: null, ...over });

const noRefs = () => null;

test("search mode proves why it matched with a bracketed snippet, not a full body", () => {
    const body = "x".repeat(2000) + " deploy the widget carefully " + "y".repeat(2000);
    const res = executeHistoryLookup({ query: "widget" }, "s1", {
        search: () => found({ hits: [hit(40, 42, body)], scanned: 40, total: 40, scannedTo: 1 }),
        refRows: noRefs,
    });
    assert.equal(res.outcome, "success");
    assert.match(res.text, /m00042/);
    assert.match(res.text, /\u3010widget\u3011/);
    // A 4 KB body must not become a 4 KB tool result.
    assert.ok(res.text.length < 900, `snippet result stayed bounded (got ${res.text.length})`);
});

test("a capped search says how much of the history it actually covered, and where to resume", () => {
    const res = executeHistoryLookup({ query: "alpha beta" }, "s1", {
        search: () => found({ hits: [hit(31, 31, "alpha and beta together")], scanned: 4000, total: 9000, capped: true, scannedTo: 5001 }),
        refRows: noRefs,
    });
    assert.match(res.text, /newest 4,000 of 9,000/);
    assert.match(res.text, /before: 31/);
    assert.match(res.text, /NOT searched/);
});

test("an empty capped search resumes from the seq it reached instead of implying absence", () => {
    const res = executeHistoryLookup({ query: "zebra" }, "s1", {
        search: () => found({ scanned: 4000, total: 9000, capped: true, scannedTo: 5001 }),
        refRows: noRefs,
    });
    assert.equal(res.outcome, "success", "no hits is an answer, not a failure");
    assert.match(res.text, /no match/);
    assert.match(res.text, /before: 5001/);
    assert.match(res.text, /older messages were NOT searched/);
});

test("an uncapped empty search is allowed to say the history was covered", () => {
    const res = executeHistoryLookup({ query: "zebra" }, "s1", {
        search: () => found({ scanned: 120, total: 120, capped: false, scannedTo: 1 }),
        refRows: noRefs,
    });
    assert.match(res.text, /whole stored history/);
});

test("range mode stops at the byte budget and hands back the continuation ref", () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(i + 1, "L".repeat(4000)));
    const res = executeHistoryLookup({ from: "m00001", to: "m00006", maxBytes: 10000 }, "s1", {
        search: () => null,
        refRows: () => rows,
    });
    assert.match(res.text, /m00001\u2013m00006: 2\/6 stored message/);
    assert.match(res.text, /continue with from:"m00003"/);
    assert.ok(res.text.length < 12000, `byte budget held (got ${res.text.length})`);
});

test("one oversized message is truncated head/tail with an explicit marker, never dropped", () => {
    const res = executeHistoryLookup({ from: "m00007", maxBytes: 4096 }, "s1", {
        search: () => null,
        refRows: () => [row(7, "Z".repeat(50000))],
    });
    assert.match(res.text, /m00007 \(user \u00b7 50,000 chars\)/);
    assert.match(res.text, /truncated: showing/);
    assert.ok(res.text.length < 8000, `truncation bounded the result (got ${res.text.length})`);
});

test("a ref with no stored row answers with guidance instead of silence", () => {
    const res = executeHistoryLookup({ from: "m00012" }, "s1", { search: () => null, refRows: () => [] });
    assert.equal(res.outcome, "success");
    assert.match(res.text, /no stored message found for m00012/);
    assert.match(res.text, /typo or a ref from a different session/);
});

test("a span wider than one call is refused with the split that works", () => {
    const res = executeHistoryLookup({ from: "m00001", to: "m00500" }, "s1", { search: () => null, refRows: noRefs });
    assert.equal(res.outcome, "failure");
    assert.match(res.text, /at most 400/);
    assert.match(res.text, /to=m00400/);
});

test("neither mode given is a usage error", () => {
    const res = executeHistoryLookup({}, "s1", { search: () => null, refRows: noRefs });
    assert.equal(res.outcome, "failure");
    assert.match(res.text, /\{query\}.*\{from,to\}/);
});

test("an unavailable unified store is reported, never answered from a guess", () => {
    const res = executeHistoryLookup({ query: "anything" }, "s1", { search: () => null, refRows: noRefs });
    assert.equal(res.outcome, "failure");
    assert.match(res.text, /unified storage index is unavailable/);
});

test("the optional session argument retargets the read", () => {
    let seen = "";
    executeHistoryLookup({ query: "x", session: "sess-other" }, "s1", {
        search: (sid) => {
            seen = sid;
            return found({ scanned: 1, total: 1, scannedTo: 0 });
        },
        refRows: noRefs,
    });
    assert.equal(seen, "sess-other");
});

test("parseRefNum accepts the shapes a model actually writes", () => {
    assert.equal(parseRefNum("m00423"), 423);
    assert.equal(parseRefNum("M423"), 423);
    assert.equal(parseRefNum("423"), 423);
    assert.equal(parseRefNum(423), 423);
    for (const bad of ["b7", "m", "", "m12x", -1, null, undefined, {}]) assert.equal(parseRefNum(bad), null, `rejects ${String(bad)}`);
});

test("a wire JSON body is surfaced as its text, raw bodies pass through", () => {
    assert.equal(readableMessageText(JSON.stringify({ role: "user", text: "hello there" })), "hello there");
    assert.equal(readableMessageText("plain body"), "plain body");
    assert.equal(readableMessageText("{not json"), "{not json");
});

test("snippets centre on the first match and stay surrogate-safe", () => {
    const text = "\ud83d\ude00".repeat(400) + " needle " + "\ud83d\ude00".repeat(400);
    const s = snippetOf(text, ["needle"]);
    assert.match(s, /\u3010needle\u3011/);
    assert.ok(s.length < 400, `snippet stayed bounded (got ${s.length})`);
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) assert.ok(i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff, "no lone high surrogate");
    }
});

test("a hit the client stopped sending is included and labelled, not hidden", () => {
    const res = executeHistoryLookup({ query: "alpha" }, "s1", {
        search: () => found({ hits: [{ ...hit(9, 9, "alpha and the old plan"), retired: true }], scanned: 20, total: 20, scannedTo: 1 }),
        refRows: noRefs,
    });
    assert.equal(res.outcome, "success");
    assert.match(res.text, /m00009 \(assistant \u00b7 retired/);
    assert.match(res.text, /retired marks a message the client no longer sends/);
});

test("renderRange reports shown/next honestly when the budget cuts mid-list", () => {
    const out = renderRange([row(1, "a".repeat(3000)), row(2, "b".repeat(3000))], 4000);
    assert.equal(out.shown, 1);
    assert.equal(out.nextRef, 2);
});
