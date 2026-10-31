export class DshRecoveryBudget {
    private remaining = 3;
    private lastRecoveryAt: number | undefined;

    constructor(private readonly now: () => number = Date.now) {}

    tryAcquire(kind: "initial" | "recovery", joining = false): { allowed: boolean; remaining: number } {
        if (kind === "initial" || joining) return { allowed: true, remaining: this.remaining };
        const now = this.now();
        if (this.remaining === 0 || (this.lastRecoveryAt !== undefined && now - this.lastRecoveryAt < 30_000)) {
            return { allowed: false, remaining: this.remaining };
        }
        this.lastRecoveryAt = now;
        this.remaining--;
        return { allowed: true, remaining: this.remaining };
    }
}
