/** Recovery respawns allowed per rolling window. Once the window slides past
 *  the earlier attempts the budget refills — a proxy that dies a few times
 *  over a long session can retry after the window expires instead of exhausting
 *  a permanent three-attempt budget. */
const RECOVERY_WINDOW_MS = 10 * 60_000;
const RECOVERY_MAX_IN_WINDOW = 3;
const RECOVERY_MIN_GAP_MS = 30_000;

export class DshRecoveryBudget {
    private readonly attempts: number[] = [];

    constructor(private readonly now: () => number = Date.now) {}

    tryAcquire(kind: "initial" | "recovery", joining = false): { allowed: boolean; remaining: number } {
        if (kind === "initial" || joining) return { allowed: true, remaining: this.remaining() };
        const now = this.now();
        while (this.attempts.length > 0 && now - this.attempts[0] >= RECOVERY_WINDOW_MS) this.attempts.shift();
        const last = this.attempts[this.attempts.length - 1];
        if (this.attempts.length >= RECOVERY_MAX_IN_WINDOW || (last !== undefined && now - last < RECOVERY_MIN_GAP_MS)) {
            return { allowed: false, remaining: this.remaining() };
        }
        this.attempts.push(now);
        return { allowed: true, remaining: this.remaining() };
    }

    private remaining(): number {
        return RECOVERY_MAX_IN_WINDOW - this.attempts.length;
    }
}
