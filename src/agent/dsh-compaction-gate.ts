// #3662: keep the always-on service required by existing preset injects so
// disabling or kill-switching bili-native cannot leave session creation pending.
// The config hook is now always identity: native Basic/manual compaction stays
// host-owned regardless of bili-native's verdict; no rows or backends are replaced.
import { registerCompactionDisable, type CompactionDisableHost } from "./dsh-compaction-disable.js";

type PluginContext = CompactionDisableHost;

export const name = "bili-compaction-gate";
export const inject: string[] = [];

export function apply(ctx: PluginContext): void {
    registerCompactionDisable(ctx);
}
