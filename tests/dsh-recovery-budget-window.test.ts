import { test } from "node:test";
import assert from "node:assert/strict";
import { DshRecoveryBudget } from "../src/agent/dsh-recovery-budget.ts";

test("recovery budget refuses past the window cap and refills after the window slides", () => {
    let now = 0;
    const b = new DshRecoveryBudget(() => now);
    assert.equal(b.tryAcquire("recovery").allowed, true);
    now += 31_000;
    assert.equal(b.tryAcquire("recovery").allowed, true);
    now += 31_000;
    assert.equal(b.tryAcquire("recovery").allowed, true);
    now += 31_000;
    assert.equal(b.tryAcquire("recovery").allowed, false, "fourth respawn inside the window is refused");
    now += 10 * 60_000;
    assert.equal(b.tryAcquire("recovery").allowed, true, "budget refills once the window has slid past");
});

test("initial spawn never consumes the recovery budget", () => {
    const b = new DshRecoveryBudget(() => 0);
    for (let i = 0; i < 5; i++) assert.equal(b.tryAcquire("initial").allowed, true);
    assert.equal(b.tryAcquire("recovery").allowed, true);
});
