import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { _nativeStateForTest, _noteRoutedForTest, _registerStateForTest, _resetRegisterForTest, _resetRoutedForTest, _setSpawnForTest, verifyAttachAndRecover } from "../src/agent/dsh-native.ts";

for (const pin of ["explicit", "routed"] as const) {
    test(`older healthy ${pin} proxy stays attached without shutdown or spawn`, async () => {
        let shutdowns = 0;
        let down = false;
        const server = http.createServer((req, res) => {
            if (req.method === "POST" && req.url === "/__bili/shutdown") {
                shutdowns++;
                down = true;
                res.writeHead(202).end();
            } else if (req.url === "/__bili/plugin/manifest" && !down) {
                res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ version: "0.0.1" }));
            } else {
                res.writeHead(503).end();
            }
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}`;
        const savedAttach = process.env.BILLION_CONTEXT_ATTACH;
        const savedProxy = process.env.BILLION_CONTEXT_PROXY;
        let spawns = 0;
        try {
            delete process.env.BILLION_CONTEXT_ATTACH;
            process.env.BILLION_CONTEXT_PROXY = origin;
            _resetRoutedForTest();
            _resetRegisterForTest(origin);
            _setSpawnForTest(async () => { spawns++; return "http://127.0.0.1:2"; });
            if (pin === "explicit") process.env.BILLION_CONTEXT_ATTACH = origin;
            else _noteRoutedForTest(`${origin}/bili/https://example.com/v1/messages`);
            assert.equal(await verifyAttachAndRecover(origin), origin);
            assert.equal(_registerStateForTest().base, origin);
            assert.equal(_nativeStateForTest().origin, origin);
            assert.equal(shutdowns, 0);
            assert.equal(spawns, 0);
            assert.equal(process.env.BILLION_CONTEXT_PROXY, origin);
        } finally {
            _setSpawnForTest(undefined);
            _resetRoutedForTest();
            _resetRegisterForTest(undefined);
            if (savedAttach === undefined) delete process.env.BILLION_CONTEXT_ATTACH; else process.env.BILLION_CONTEXT_ATTACH = savedAttach;
            if (savedProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY; else process.env.BILLION_CONTEXT_PROXY = savedProxy;
            await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
        }
    });
}
