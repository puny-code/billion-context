// OpenCode's API rejects model requests that lack a stable per-conversation
// session header (HTTP 400 MissingSessionID). Hosts stamp it on only SOME of
// their model paths (background/agentless lanes lose it), so bili must fill it
// in on egress whenever it is the one carrying the request.
import assert from "node:assert/strict";
import test from "node:test";
import { stampOpenCodeSessionHeader } from "../src/server/headers.js";

const GO = "https://opencode.ai/inference/go/openai/v1/chat/completions";

test("egress to opencode.ai gets the session header when the client sent none", () => {
    const headers: Record<string, string> = { authorization: "Bearer k" };
    stampOpenCodeSessionHeader(headers, "sess-1", GO);
    assert.equal(headers["x-opencode-session"], "sess-1");
    assert.equal(headers["authorization"], "Bearer k", "other headers untouched");
});

test("a client-supplied session header always wins over bili's", () => {
    const headers: Record<string, string> = { "X-OpenCode-Session": "from-client" };
    stampOpenCodeSessionHeader(headers, "sess-1", GO);
    const values = Object.entries(headers).filter(([k]) => k.toLowerCase() === "x-opencode-session");
    assert.deepEqual(values, [["X-OpenCode-Session", "from-client"]]);
});

test("non-OpenCode hosts are never stamped", () => {
    for (const url of [
        "https://api.anthropic.com/v1/messages",
        "https://opencode.ai.evil.example/inference/go/openai/v1/chat/completions",
        "https://evil-opencode.ai/inference/go/openai/v1/chat/completions",
        "not-a-url",
    ]) {
        const headers: Record<string, string> = {};
        stampOpenCodeSessionHeader(headers, "sess-1", url);
        assert.deepEqual(headers, {}, `untouched for ${url}`);
    }
});

test("without a session id nothing is invented", () => {
    const headers: Record<string, string> = {};
    stampOpenCodeSessionHeader(headers, undefined, GO);
    assert.deepEqual(headers, {});
});
