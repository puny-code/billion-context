import test from "node:test";
import assert from "node:assert/strict";
import { DshRecoveryBudget } from "../src/agent/dsh-recovery-budget.ts";

test("initial startup is free and does not delay the first background recovery", () => {
    const budget = new DshRecoveryBudget(() => 0);
    assert.deepEqual(budget.tryAcquire("initial"), { allowed: true, remaining: 3 });
    assert.deepEqual(budget.tryAcquire("recovery"), { allowed: true, remaining: 2 });
});

test("recovery denies before 30 seconds and allows at the exact boundary", () => {
    let now = 0;
    const budget = new DshRecoveryBudget(() => now);
    assert.deepEqual(budget.tryAcquire("recovery"), { allowed: true, remaining: 2 });
    now = 29_999;
    assert.deepEqual(budget.tryAcquire("recovery"), { allowed: false, remaining: 2 });
    now = 30_000;
    assert.deepEqual(budget.tryAcquire("recovery"), { allowed: true, remaining: 1 });
    now = 59_999;
    assert.deepEqual(budget.tryAcquire("recovery"), { allowed: false, remaining: 1 });
    now = 60_000;
    assert.deepEqual(budget.tryAcquire("recovery"), { allowed: true, remaining: 0 });
});

test("singleflight joins are free and do not move the next recovery time", () => {
    let now = 0;
    const budget = new DshRecoveryBudget(() => now);
    assert.deepEqual(budget.tryAcquire("recovery"), { allowed: true, remaining: 2 });
    now = 29_999;
    assert.deepEqual(budget.tryAcquire("recovery", true), { allowed: true, remaining: 2 });
    assert.deepEqual(budget.tryAcquire("recovery", true), { allowed: true, remaining: 2 });
    now = 30_000;
    assert.deepEqual(budget.tryAcquire("recovery"), { allowed: true, remaining: 1 });
});

test("three successful background recoveries exhaust the activation permanently", async () => {
    let now = 0;
    const budget = new DshRecoveryBudget(() => now);
    for (const remaining of [2, 1, 0]) {
        assert.deepEqual(budget.tryAcquire("recovery"), { allowed: true, remaining });
        await Promise.resolve("recovered");
        now += 30_000;
    }
    assert.deepEqual(budget.tryAcquire("recovery"), { allowed: false, remaining: 0 });
    now += 86_400_000;
    assert.deepEqual(budget.tryAcquire("initial"), { allowed: true, remaining: 0 });
    assert.deepEqual(budget.tryAcquire("recovery"), { allowed: false, remaining: 0 });
    assert.deepEqual(budget.tryAcquire("recovery", true), { allowed: true, remaining: 0 });
});

test("only a new activation instance gets a fresh budget and cooldown", () => {
    let now = 0;
    const previous = new DshRecoveryBudget(() => now);
    for (let attempt = 0; attempt < 3; attempt++) {
        previous.tryAcquire("recovery");
        now += 30_000;
    }
    assert.deepEqual(previous.tryAcquire("recovery"), { allowed: false, remaining: 0 });
    const next = new DshRecoveryBudget(() => now);
    assert.deepEqual(next.tryAcquire("initial"), { allowed: true, remaining: 3 });
    assert.deepEqual(next.tryAcquire("recovery"), { allowed: true, remaining: 2 });
    assert.deepEqual(previous.tryAcquire("recovery"), { allowed: false, remaining: 0 });
});
