// Compatibility gate for existing preset inject dependencies (#3354/#3662).
// Bili enhances context opportunistically; native Basic and manual compaction
// remain host-owned and are never disabled or replaced by this gate.
export const BILI_COMPACTION_DISABLE_SERVICE = "biliBasicCompactionPolicy";
const DSH_WEB_PRESET_IDS = ["preset-standard", "preset-ptc", "preset-minimal", "preset-cordis"] as const;

export function compactionDisablePatchRows(): string {
    return DSH_WEB_PRESET_IDS.map((id) => `- id: ${id}\n  inject: [${BILI_COMPACTION_DISABLE_SERVICE}]\n`).join("");
}

const DSH_COMPACTION_VERDICT_KEY = "__BILI_DSH_COMPACTION_VERDICT__";

/** Compatibility status only: this verdict never changes native compaction. */
export function declareDshCompactionActive(): void {
    (globalThis as Record<string, unknown>)[DSH_COMPACTION_VERDICT_KEY] = "active";
}

export function declareDshCompactionInactive(): void {
    (globalThis as Record<string, unknown>)[DSH_COMPACTION_VERDICT_KEY] = "inactive";
}

export function isDshCompactionActive(): boolean {
    return (globalThis as Record<string, unknown>)[DSH_COMPACTION_VERDICT_KEY] === "active";
}

export function _resetDshCompactionVerdictForTest(): void {
    delete (globalThis as Record<string, unknown>)[DSH_COMPACTION_VERDICT_KEY];
}

const DSH_COMPACTION_GATE_TELEMETRY_KEY = "__BILI_DSH_COMPACTION_GATE_TELEMETRY__";

export type DshCompactionGateTelemetry = {
    covered: Array<{ entry: string; rows: number }>;
    sawFactoryPreset: boolean;
};

/** No native rows are rewritten under the non-exclusive policy. */
export function dshCompactionGateTelemetry(): DshCompactionGateTelemetry | null {
    return null;
}

export function _resetDshCompactionGateTelemetryForTest(): void {
    delete (globalThis as Record<string, unknown>)[DSH_COMPACTION_GATE_TELEMETRY_KEY];
}

/** Legacy export retained without its former native-disable behavior. */
export function disableBasicCompaction(rows: readonly unknown[]): unknown[] {
    return [...rows];
}

export type CompactionDisableHost = {
    on?: (event: string, listener: (raw: unknown, next: () => unknown) => unknown, options?: { global?: boolean }) => void;
    reflect?: { provide?: (name: string, value: unknown) => void } | undefined;
};

export function registerCompactionDisable(ctx: CompactionDisableHost): void {
    ctx.on?.("internal/config", (_raw, next) => next(), { global: true });
    ctx.reflect?.provide?.(BILI_COMPACTION_DISABLE_SERVICE, Object.freeze({ owner: "billion-context", issue: "#3354" }));
}

type CompactionOverlayGap = "no-config-hook" | "no-service-provide";

/** Legacy capability diagnostic; a missing hook no longer suppresses native rows. */
export function detectCompactionOverlayGap(ctx: CompactionDisableHost): CompactionOverlayGap | null {
    if (typeof ctx.on !== "function") return "no-config-hook";
    if (typeof ctx.reflect?.provide !== "function") return "no-service-provide";
    return null;
}
