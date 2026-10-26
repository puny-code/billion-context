// #1590: browser half of the dsh dual-face plugin (dsh.client). The tsup
// build wraps this CJS body in window.__ModuleLoader__.load({id, factory}) —
// two load-bearing invariants invisible from this file alone: the id MUST
// equal the loader entry name the scanner keys its graph row by ("loaded
// without registering" otherwise), and the factory's `require` resolves only
// through dsh's module system, so react is the sole permitted external.
// Origin discovery has two paths (#1809): the host half (dsh-native.ts)
// injects globalThis.__BILI__ = {origin} into the web index at render time —
// a boot-time snapshot that a page loaded before spawn-mode bootstrap (or a
// desktop boot payload, captured once per app launch) never carries — and it
// serves the live origin at GET /bili/origin on the dsh webserver. The
// snapshot is only a FIRST-PAINT HINT (#2288): attach-mode presets publish
// the env origin at startup while the host re-binds it at runtime (dead-attach
// fallback spawn, routed-origin convergence), so freezing on whatever the page
// captured left the button pointing at a dead URL for the whole session. This
// section therefore keeps polling the live route for the whole mount (fast
// until the first resolution, slow after) and the entry follows wherever the
// proxy actually listens — no reload or app restart. Neither source known ⇒
// degrade to a hint instead of a dead link. #2321: once bound, the panel
// embeds the REAL web UI — a native tab bar (overview/sessions/config/logs)
// driving one iframe at origin/__bili/ with ?embed=1 plus a hash route; tab
// switches move only the fragment, so the frame navigates same-document
// (hashchange) without a full reload — and since its src tracks the polled
// origin, a mid-session re-bind moves the frame in place too. The
// open-in-browser button survives as the escape hatch; #2448: the host panel
// is a NARROW column, so the backup button keeps the origin in a tooltip
// instead of the label (a URL + nowrap squeezed the hint row into a sliver)
// and the frame height follows the host viewport. lang mirrors the host
// locale: bind() resolves against the live dsh locale, and comparing the
// resolved nav label with the registered zh value is the only locale signal
// the client contract exposes. #2559: theme follows the HOST page too —
// an app-level dsh dark setting is invisible to the framed document's
// prefers-color-scheme, so we sample the actual on-screen ground of this page
// (same-origin) and pin the face via &theme=light|dark; first paint reads it
// synchronously, later probe ticks pick up mid-session toggles. The same panel is mounted at two slots (#2125): settings.section
// (always present — the launcher posture has no bundle page) and
// plugins.bundle.config (keyed by package name; the plugin detail page renders
// it only when this package is installed as a profile bundle and draws the
// title itself, so that registration drops the h3). #3862: a THIRD face — a
// per-session Context tab in the official dsh client (conversation.view slot).
// dsh exposes no API to edit the context stream, so host-side stat plugins
// anchored on the event log can never observe bili's folds (their bar freezes
// at the pre-compression caliber, dsh-context#173); the tab instead renders
// the proxy's OWN live view (GET /__bili/plugin/status `contextView`: the
// post-fold sent composition recomputed by the kernel + fold/switch trails
// from the cache ledger). It is native DOM in this bundle, NOT an iframe
// (owner directive): react stays the single external, no second document.

import { createElement, useEffect, useState } from "react";

type Dict = Record<string, string>;

type SlotOptions =
    | { name: string; id: string; order: number; label: () => string; locale: string }
    | { name: string; key: string; locale: string };

type ClientContext = {
    effect: (fn: () => void | (() => void), label?: string) => void;
    locale: {
        register: (ns: string, dict: { zh: Dict; en: Dict }) => void;
        bind: (ns: string) => (key: string) => string;
    };
    slots: {
        inject: (slot: string, provide: () => void) => void;
        register: (options: SlotOptions, component: (props: Record<string, unknown>) => unknown) => unknown;
    };
};

export const inject = ["slots", "locale"];

const NS = "bili";

// #1809/#2187/#2288: live-origin probe cadence — first attempt immediate,
// then a retry every POLL_INTERVAL_MS for POLL_MAX_ATTEMPTS total (~30s),
// after which probing CONTINUES at SLOW_POLL_INTERVAL_MS until the page
// unmounts. #2187: the server side now heals a failed spawn-mode bootstrap
// in the background and a slow Windows boot can take minutes, so stopping at
// ~30s stranded the entry on "not bound" for the whole session. #2288: the
// slow phase also runs AFTER the first resolution — the host re-binds the
// origin mid-session (runtime re-spawn, routed-origin convergence), so the
// entry keeps following the live route instead of freezing on the first value.
const ORIGIN_PATH = "/bili/origin";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 10;
const SLOW_POLL_INTERVAL_MS = 10000;

// #2321: pages offered by the embedded face, in tab-bar order. Labels mirror
// the web UI's own nav terminology (src/web/i18n.ts) so each tab reads like
// the title of the page inside the frame. "connect" stays out: it documents
// how OTHER clients reach this proxy, which makes no sense from inside dsh.
const PAGE_IDS = ["overview", "sessions", "config", "logs"] as const;
type PageId = (typeof PAGE_IDS)[number];
const PAGE_KEYS: Record<PageId, string> = {
    overview: "tab_overview",
    sessions: "tab_sessions",
    config: "tab_config",
    logs: "tab_logs",
};

// #3816: the exact field a remote user adds to enable the #3373 relay. A
// fragment on purpose — pasting a whole object would clobber an existing
// config's other keys.
const REMOTE_RELAY_SNIPPET = '"security": { "adminRelay": true }';
const EMBED_HEIGHT = "min(640px, 78vh)";

// One look for the panel's action buttons (footer backup entry, #3816
// config-page jump) so the placements cannot drift apart visually.
const ACTION_BTN_STYLE = {
    cursor: "pointer",
    borderRadius: 8,
    border: "1px solid rgba(127,127,127,0.4)",
    background: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: 14,
    lineHeight: "22px",
    padding: "7px 16px",
    whiteSpace: "nowrap",
};

// #3862: Context tab data source + cadence. The status URL is the SAME
// canonical form the dsh lane uses server-side (/acp command), so the tab and
// the slash command can never read two different sessions. Polling is slow by
// design: the view only changes on model requests, 10s is imperceptible lag
// at zero cost.
const CTX_STATUS_PATH = "/__bili/plugin/status?conversationId=dsh&fallback=latest";
const CTX_POLL_MS = 10000;
const CTX_EVENT_ROWS = 12;

// Segment palette: GitHub-dark category colors, readable on both host themes
// (segments sit on a neutral track, not on the page ground).
const CATEGORY_COLOR: Record<string, string> = {
    sysprompt: "#6e7781",
    tool: "#d29922",
    text: "#58a6ff",
    code: "#bc8cff",
    summaries: "#3fb950",
    system: "#8b949e",
};
const CATEGORY_LABEL_KEYS: Record<string, string> = {
    sysprompt: "cat_sysprompt",
    tool: "cat_tool",
    text: "cat_text",
    code: "cat_code",
    summaries: "cat_summaries",
    system: "cat_system",
};
const ANCHOR_KIND_KEYS: Record<string, string> = {
    usage: "ctx_anchor_kind_usage",
    estimate: "ctx_anchor_kind_estimate",
    upper: "ctx_anchor_kind_upper",
};
const SWITCH_KEYS: Record<string, string> = {
    model: "ctx_switch_model",
    key: "ctx_switch_key",
    prompt: "ctx_switch_prompt",
    restart: "ctx_switch_restart",
};

function categoryColor(key: string): string {
    return CATEGORY_COLOR[key] ?? "#8b949e";
}

function categoryLabel(key: string, t: (k: string) => string): string {
    const k = CATEGORY_LABEL_KEYS[key];
    return k !== undefined ? t(k) : key;
}

function num(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function numOrNull(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

function arr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

function rec(v: unknown): Record<string, unknown> | null {
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function fmtTok(n: number): string {
    if (!Number.isFinite(n)) return "?";
    if (n < 1000) return String(Math.round(n));
    if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
}

function fmtTime(at: number, lang: "zh" | "en"): string {
    try {
        return new Date(at).toLocaleTimeString(lang === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" });
    } catch {
        return "";
    }
}

type CtxCategory = { key: string; tokens: number; pct: number };
type CtxFoldEvent = { seq: number; at: number; s: number; sigma: number; reclaimed: number; savedSoFar: number };
type CtxSwitchEvent = { dim: string; at: number; from: string | null; to: string; attributed: number };
type CtxAnchor = { tokens: number; kind: string; at: number | null };
type CtxView = { limit: number | null; sentTotal: number; growth: number; categories: CtxCategory[]; anchor: CtxAnchor | null; folds: CtxFoldEvent[]; switches: CtxSwitchEvent[] };
type CtxStatus = { ok: boolean; phase?: string; panelPresent: boolean; contextView: CtxView | null };

/** Parse the /__bili/plugin/status body into the tab's render shape. Every
 *  field is guard-wrapped: an older or foreign build answering the URL must
 *  yield `undefined` (→ degraded states), never a crash mid-render. */
function parseCtxStatus(raw: unknown): CtxStatus | undefined {
    const o = rec(raw);
    if (o === null || typeof o.ok !== "boolean") return undefined;
    let view: CtxView | null = null;
    const v = rec(o.contextView);
    if (v !== null) {
        const a = rec(v.anchor);
        view = {
            limit: numOrNull(v.limit),
            sentTotal: num(v.sentTotal),
            growth: num(v.growth),
            categories: arr(v.categories)
                .map((c) => {
                    const r = rec(c);
                    return r === null || typeof r.key !== "string" || r.key.length === 0 ? undefined : { key: r.key, tokens: num(r.tokens), pct: num(r.pct) };
                })
                .filter((c): c is CtxCategory => c !== undefined),
            anchor: a === null ? null : { tokens: num(a.tokens), kind: typeof a.kind === "string" ? a.kind : "estimate", at: typeof a.at === "number" ? a.at : null },
            folds: arr(v.folds)
                .map((f) => {
                    const r = rec(f);
                    return r === null ? undefined : { seq: num(r.seq), at: num(r.at), s: num(r.s), sigma: num(r.sigma), reclaimed: num(r.reclaimed), savedSoFar: num(r.savedSoFar) };
                })
                .filter((f): f is CtxFoldEvent => f !== undefined),
            switches: arr(v.switches)
                .map((s) => {
                    const r = rec(s);
                    return r === null || typeof r.dim !== "string" || r.dim.length === 0
                        ? undefined
                        : { dim: r.dim, at: num(r.at), from: typeof r.from === "string" ? r.from : null, to: typeof r.to === "string" ? r.to : "?", attributed: num(r.attributed) };
                })
                .filter((s): s is CtxSwitchEvent => s !== undefined),
        };
    }
    return { ok: o.ok, phase: typeof o.phase === "string" ? o.phase : undefined, panelPresent: o.panel !== undefined, contextView: view };
}

/** Shared open-in-browser action — one builder for the settings-panel footer,
 *  the embedded tab row and the Context tab so the placements cannot drift
 *  (label, tooltip, target). Returns null while the origin is unknown. */
function openWebButton(origin: string | undefined, t: (key: string) => string, style?: Record<string, string>): ReturnType<typeof createElement> {
    return origin === undefined
        ? null
        : createElement(
            "button",
            {
                type: "button",
                title: origin,
                onClick: () => openExternal(`${origin}/__bili/`),
                style: { ...ACTION_BTN_STYLE, ...style },
            },
            t("open"),
        );
}

// #3100: pre-flight for the framed face. Auto-update refreshes the profile
// bundle on DISK while the long-running proxy child keeps serving the code it
// booted with — and this browser half always runs the freshest disk code — so
// right after an update it frames a route the frozen server may not have yet
// (the query form landed in v0.1.189; older builds answer it with a raw JSON
// 404 inside the frame). Probe the exact embed URL once per origin BEFORE
// mounting: HTML ⇒ mount the frame; any other answer ⇒ the running build
// predates the route ⇒ show the restart notice instead (the backup button
// targets the bare /__bili/ form every build serves). A network error yields
// no verdict — the origin poll re-probes on its regular ticks. Verdicts are
// cached per origin for the page lifetime: a frozen process cannot gain
// routes mid-session.
const EMBED_PROBE_PATH = "/__bili/?embed=1";
type EmbedVerdict = "ok" | "stale";
type EmbedState = { origin: string; verdict: EmbedVerdict };
const embedVerdicts = new Map<string, EmbedVerdict>();
const embedProbesInFlight = new Set<string>();

function probeEmbedRoute(origin: string, onVerdict: (state: EmbedState) => void): void {
    if (typeof fetch !== "function") return;
    const cached = embedVerdicts.get(origin);
    if (cached !== undefined) {
        onVerdict({ origin, verdict: cached });
        return;
    }
    if (embedProbesInFlight.has(origin)) return;
    embedProbesInFlight.add(origin);
    void fetch(`${origin}${EMBED_PROBE_PATH}`)
        .then((res) => {
            let html = false;
            try {
                const ct = typeof res.headers.get === "function" ? res.headers.get("content-type") : "";
                html = res.ok && String(ct ?? "").includes("text/html");
            } catch {
                html = false;
            }
            const verdict: EmbedVerdict = html ? "ok" : "stale";
            embedVerdicts.set(origin, verdict);
            try {
                void res.body?.cancel?.().catch(() => {});
            } catch {
                // non-stream body (harness): nothing to release
            }
            onVerdict({ origin, verdict });
        })
        .catch(() => {
            // unreachable right now: no verdict, the next poll tick retries
        })
        .finally(() => {
            embedProbesInFlight.delete(origin);
        });
}

/** #2559: classify the host page's actual ground as light/dark. The framed
 *  bili face is a separate document — it only sees the browser/OS
 *  color-scheme, while dsh's dark theme is app-level. Same origin lets us
 *  sample what the user actually sees: walk the usual ground candidates,
 *  read each opaque background-color, vote by simple weighted luminance
 *  (near-black app grounds < 0.4, near-white > 0.4). No readable signal at
 *  all ⇒ fall back to the OS signal; nothing even for that ⇒ undefined and
 *  the frame stays OS-driven. Every read is guard-wrapped: older hosts or
 *  minimal DOMs must degrade to "no pin", never crash the panel. */
type ThemeDom = {
    document?: { documentElement?: unknown; body?: { querySelector?: (sel: string) => unknown } & Record<string, unknown> };
    getComputedStyle?: (el: unknown) => { backgroundColor?: unknown };
    matchMedia?: (q: string) => { matches: boolean };
};
function detectHostTheme(): "light" | "dark" | undefined {
    const g = globalThis as ThemeDom;
    try {
        const doc = g.document;
        if (!doc || typeof g.getComputedStyle !== "function") return undefined;
        const candidates: unknown[] = [];
        if (doc.documentElement) candidates.push(doc.documentElement);
        if (doc.body) candidates.push(doc.body);
        try {
            for (const sel of ["main", "[role=main]", "#root", "#app"]) {
                const el = doc.body?.querySelector?.(sel);
                if (typeof el === "object" && el !== null) candidates.push(el);
            }
        } catch {
            // non-DOM harness: ground sampling below just yields no votes
        }
        let lightVotes = 0;
        let darkVotes = 0;
        for (const c of candidates) {
            let bg: string;
            try {
                const v = g.getComputedStyle!(c).backgroundColor;
                if (typeof v !== "string") continue;
                bg = v;
            } catch {
                continue;
            }
            const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\/\s]+([\d.]+))?\)/.exec(bg);
            if (!m) continue; // transparent / named / unparsable → no vote
            const alpha = m[4] !== undefined ? Number(m[4]) : 1;
            if (alpha <= 0.5) continue;
            const luma = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
            if (luma <= 0.4) darkVotes += 1;
            else lightVotes += 1;
        }
        if (darkVotes !== lightVotes && (darkVotes > 0 || lightVotes > 0)) return darkVotes > lightVotes ? "dark" : "light";
    } catch {
        return undefined;
    }
    try {
        const mq = g.matchMedia?.("(prefers-color-scheme: dark)");
        if (mq) return mq.matches ? "dark" : "light";
    } catch {
        // no media support either — leave the face OS-driven
    }
    return undefined;
}

const zh: Dict = {
    "nav": "bili设置",
    "title": "billion-context 压缩代理",
    "open": "打开 Web UI",
    "hint": "查看压缩状态、会话与上下文窗口。",
    "degraded": "当前 dsh 进程未绑定 bili 代理（未经 bili dsh 启动，或代理尚未就绪）——先运行 /acp，或改用 bili dsh 启动。",
    "connecting": "正在连接 bili 代理…",
    "stale": "运行中的 bili 代理比已安装的配置文件旧：本页面已加载新版界面，但代理进程仍在提供旧版服务，暂时无法打开内嵌页面。若本应用已运行新版本，启动一个新会话即会自动换上新代理（也可手动结束旧代理进程立即生效）；若应用本身还是旧版本，请完全退出并重新启动 dsh。恢复前可点下方按钮直接打开 Web UI。",
    "remote_blocked": "本页面通过远程地址访问，而 bili 面板运行在服务器本机的回环地址（127.0.0.1）上——你的浏览器无法直连它（直连会指向你自己的电脑）。要远程打开面板：在服务器上编辑 ~/.config/billion-context/billion-context.json，向顶层对象加入下方字段并保存——本页会在数秒内自动生效（无需重启 dsh，刷新页面同样可以）；若你能直接访问该面板地址，也可点下方按钮在配置页开启。",
    "remote_open_config": "打开配置页",
    "tab_overview": "总览",
    "tab_sessions": "会话",
    "tab_config": "配置",
    "tab_logs": "日志",
    "tab_ctx": "上下文",
    "ctx_sent": "发送到模型（压缩后，估算）",
    "ctx_anchor": "计费口径",
    "ctx_anchor_kind_usage": "usage 实测",
    "ctx_anchor_kind_estimate": "估算（锚定 usage）",
    "ctx_anchor_kind_upper": "上界估算",
    "cat_sysprompt": "系统提示与工具定义",
    "cat_tool": "工具调用与结果",
    "cat_text": "对话文本",
    "cat_code": "代码",
    "cat_summaries": "压缩摘要",
    "cat_system": "历史系统消息",
    "ctx_events": "事件",
    "ctx_fold": "压缩",
    "ctx_reclaimed": "回收",
    "ctx_saved": "累计节省",
    "ctx_switch_model": "模型切换",
    "ctx_switch_key": "密钥切换",
    "ctx_switch_prompt": "提示词变化",
    "ctx_switch_restart": "代理重启",
    "ctx_empty_events": "本会话暂无压缩或切换事件。",
    "ctx_waiting": "等待首个模型请求…",
    "ctx_nodata": "暂无上下文数据——完成一次模型请求后自动刷新。",
    "ctx_stale": "运行中的 bili 代理比已安装的配置文件旧：本页面已加载新版界面，但代理进程尚未提供结构化上下文数据（重启后即可）。恢复前可点下方按钮打开 Web UI。",
    "ctx_stale_data": "数据可能不是最新。",
    "ctx_refresh": "刷新",
    "ctx_hint": "柱状图为 bili 代理实时重算的估算口径；计费行来自 provider 实测 usage——两者口径不同，不可直接相减。",
};

const en: Dict = {
    "nav": "bili",
    "title": "billion-context compression proxy",
    "open": "Open Web UI",
    "hint": "Inspect compression status, sessions and context windows.",
    "degraded": "This dsh process is not bound to a bili proxy (not launched via bili dsh, or the proxy is not up yet) — run /acp first, or launch through bili dsh.",
    "connecting": "Connecting to the bili proxy…",
    "stale": "The running bili proxy is older than the installed profile: this page already runs the new face, but the proxy process still serves the old build, so the embedded page cannot be opened yet. If this app itself runs the new version, starting a new session swaps in the new proxy automatically (or kill the old proxy process manually for an immediate switch); if the app itself is still on the old version, fully quit and relaunch dsh. Until then, use the button below to open the Web UI directly.",
    "remote_blocked": "This page is reached through a remote address, but the bili panel runs on the server's own loopback address (127.0.0.1) — your browser cannot reach it directly (it would point at your own machine). To open the panel remotely: edit ~/.config/billion-context/billion-context.json on the server and add the field below to the top-level object — this page picks it up within seconds (no dsh restart needed; reloading works too); if you CAN reach that panel address directly, use the button below to enable it from the config page.",
    "remote_open_config": "Open config page",
    "tab_overview": "Overview",
    "tab_sessions": "Sessions",
    "tab_config": "Config",
    "tab_logs": "Logs",
    "tab_ctx": "Context",
    "ctx_sent": "Sent to model (post-compression, est.)",
    "ctx_anchor": "Billed reading",
    "ctx_anchor_kind_usage": "provider-measured usage",
    "ctx_anchor_kind_estimate": "estimate anchored on usage",
    "ctx_anchor_kind_upper": "upper-bound estimate",
    "cat_sysprompt": "System prompt & tool defs",
    "cat_tool": "Tool calls & results",
    "cat_text": "Conversation text",
    "cat_code": "Code",
    "cat_summaries": "Compression summaries",
    "cat_system": "Historic system messages",
    "ctx_events": "Events",
    "ctx_fold": "Fold",
    "ctx_reclaimed": "reclaimed",
    "ctx_saved": "saved so far",
    "ctx_switch_model": "Model switch",
    "ctx_switch_key": "Key switch",
    "ctx_switch_prompt": "Prompt change",
    "ctx_switch_restart": "Proxy restart",
    "ctx_empty_events": "No compression or switch events yet.",
    "ctx_waiting": "Waiting for the first model request…",
    "ctx_nodata": "No context data yet — refreshes automatically after the first model request.",
    "ctx_stale": "The running bili proxy is older than the installed profile: this page already runs the new face, but the proxy process does not serve structured context data yet (a restart fixes it). Until then, use the button below to open the Web UI directly.",
    "ctx_stale_data": "Data may be stale.",
    "ctx_refresh": "Refresh",
    "ctx_hint": "The bar is the proxy's live recompute on the estimate scale; the billed line uses provider-measured usage — different scales, never subtract them.",
};

function readOrigin(): string | undefined {
    const g = globalThis as { __BILI__?: { origin?: unknown; relay?: unknown; ui?: unknown } };
    const snap = g.__BILI__;
    // #3373: relay snapshot — the entry serves the admin surface itself, so
    // the base is same-origin ("" = entry-relative paths). Prefix gateways
    // correct this to an absolute base on the first live probe.
    if (snap !== undefined && snap.relay === true) return "";
    const origin = snap?.origin;
    return typeof origin === "string" && origin.length > 0 ? origin : undefined;
}

// USER-REQUESTED (no issue): global master gate for all three client faces,
// DEFAULT OFF. The host stamps the effective `dsh.uiFaces` value into the
// __BILI__ snapshot (src/agent/dsh-native.ts); a missing or non-true flag
// means the faces stay unregistered — with other context plugins installed
// the extra tabs are noise.
function readUiFaces(): boolean {
    const g = globalThis as { __BILI__?: { ui?: unknown } };
    return g.__BILI__?.ui === true;
}

function openExternal(url: string): void {
    const w = globalThis as { open?: (url: string, target?: string, features?: string) => unknown };
    if (typeof w.open === "function") w.open(url, "_blank", "noopener,noreferrer");
}

/** #3373: relay mode — the probe response carries `relay: true` instead of
 *  a loopback origin. Derive the UI base from the probe's own response URL:
 *  whatever origin+prefix carried the probe also serves /__bili/. An empty
 *  base means same-origin paths (root deployments, test harnesses). */
function relayBaseOf(res: { url?: unknown }): string {
    const url = typeof res.url === "string" ? res.url : "";
    if (url.endsWith(ORIGIN_PATH)) {
        const base = url.slice(0, -ORIGIN_PATH.length).replace(/\/+$/, "");
        return base.length > 0 ? base : "";
    }
    return "";
}

/** #3816: hosts that mean "this machine" from the browser's point of view. */
function isLoopbackHost(host: string): boolean {
    const h = host.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

// #3816: remote-access mismatch — the bound origin is the server's loopback
// while THIS page was reached through a non-loopback address, so the
// browser's 127.0.0.1 is its own machine and the origin is unreachable by
// construction. Left alone the entry spins on "connecting…" forever and the
// backup button opens a dead link; instead the face explains the fix
// (security.adminRelay, #3373). Client-side detection on purpose: server
// socket inspection breaks under reverse proxies. Undecidable (no location,
// no URL constructor, unparsable origin) ⇒ false ⇒ old behavior stands.
function remoteMismatch(origin: string | undefined): boolean {
    if (origin === undefined || origin.length === 0) return false; // relay mode: same-origin paths are reachable by construction
    let parsed: { hostname?: unknown };
    try {
        parsed = new URL(origin);
    } catch {
        return false;
    }
    const originHost = typeof parsed.hostname === "string" ? parsed.hostname : "";
    if (!isLoopbackHost(originHost)) return false;
    const g = globalThis as { location?: { hostname?: unknown } };
    const pageHost = typeof g.location?.hostname === "string" ? g.location.hostname : "";
    return pageHost.length > 0 && !isLoopbackHost(pageHost);
}

// #3373: gateways that mount dsh web under a path prefix re-map every URL
// the index references, so the absolute probe path misses. Probe relative to
// the page's own base as a second form; the last form that answered wins the
// next tick (direct hosts never leave the primary form).
let winningProbeForm: string | undefined;

function probeForms(): string[] {
    if (winningProbeForm !== undefined) return [winningProbeForm];
    const doc = (globalThis as { document?: { baseURI?: unknown } }).document;
    const baseURI = typeof doc?.baseURI === "string" && doc.baseURI.length > 0 ? doc.baseURI : undefined;
    if (baseURI === undefined) return [ORIGIN_PATH];
    try {
        const fallback = new URL("bili/origin", baseURI).toString();
        return fallback === ORIGIN_PATH ? [ORIGIN_PATH] : [ORIGIN_PATH, fallback];
    } catch {
        return [ORIGIN_PATH];
    }
}

/** #1809/#2187/#2288: follow the host's live origin route for the lifetime
 *  of the mount; returns the cancel used as the effect cleanup (no fetch ⇒
 *  no-op, older hosts without the route simply stay on the snapshot or
 *  degrade). The snapshot is only a first-paint hint — the host re-binds the
 *  origin at runtime, so polling never stops after a resolution.
 *  #2559: every successful tick also re-classifies the host ground and pushes
 *  a fresh theme pin — mid-session theme toggles land within one slow phase.
 *  No extra timers are scheduled here (the test pins in tests/dsh-settings-ui
 *  count every delay on this queue). */
function probeOrigin(onOrigin: (origin: string) => void, onTheme?: (theme: "light" | "dark") => void, onTick?: (origin: string) => void): () => void {
    if (typeof fetch !== "function") return () => {};
    let cancelled = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const poll = async (): Promise<void> => {
        // #3373: try the known-good form first — under a path-prefix gateway
        // that becomes the relative form after its first hit.
        let sawOk = false;
        for (const form of probeForms()) {
            try {
                const res = await fetch(form);
                if (!res.ok) continue;
                sawOk = true;
                const data = (await res.json()) as { origin?: unknown; relay?: unknown };
                let bind: string | undefined;
                if (data.relay === true) bind = relayBaseOf(res);
                else if (typeof data.origin === "string" && data.origin.length > 0) bind = data.origin;
                if (bind !== undefined && !cancelled) {
                    winningProbeForm = form;
                    onOrigin(bind);
                    settled = true;
                    // #3100: every resolution is also an embed-probe retry slot —
                    // a snapshot-only origin (older hosts without the route)
                    // never flows through onOrigin again after mount.
                    if (onTick !== undefined) onTick(bind);
                    break;
                }
            } catch {
                // host without the route (older builds) or transient error: try the next form
            }
        }
        if (sawOk && onTheme && !cancelled) {
            const theme = detectHostTheme();
            if (theme !== undefined) onTheme(theme);
        }
        if (cancelled) return;
        attempts += 1;
        // #2187/#2288: fast phase until the first resolution, then an endless
        // slow phase — the origin can land (background heal) or move
        // (runtime re-bind) at any time.
        const delay = !settled && attempts < POLL_MAX_ATTEMPTS ? POLL_INTERVAL_MS : SLOW_POLL_INTERVAL_MS;
        if (!cancelled) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
    };
}

export function apply(ctx: ClientContext): void {
    const zhDict = zh;
    const enDict = en;
    ctx.effect(
        () => ctx.locale.register(NS, { zh: zhDict, en: enDict }),
        "bili: dictionaries",
    );
    // USER-REQUESTED (no issue): global master gate, default off — register
    // no faces (settings entry, bundle config panel, Context tab) unless the
    // host snapshot opted in. The locale registration above stays: it is
    // inert without faces and keeps the bundle's dictionary contract stable.
    if (!readUiFaces()) return;
    const t = ctx.locale.bind(NS);
    // #3862: per-session Context tab (conversation.view slot). Native DOM card
    // fed by the proxy's live contextView — see parseCtxStatus for the wire
    // contract and src/context-view.ts for the scale discipline.
    const contextPanel = (): ((props: Record<string, unknown>) => unknown) => () => {
        const [origin, setOrigin] = useState<string | undefined>(readOrigin());
        const [status, setStatus] = useState<CtxStatus | undefined>(undefined);
        const [fetchFailed, setFetchFailed] = useState(false);
        const [reloadTick, setReloadTick] = useState(0);
        useEffect(() => probeOrigin(setOrigin), []);
        useEffect(() => {
            if (origin === undefined) return;
            let cancelled = false;
            const load = (): void => {
                void fetch(`${origin}${CTX_STATUS_PATH}`)
                    .then((res) => res.json() as Promise<unknown>)
                    .then((raw) => {
                        if (cancelled) return;
                        const parsed = parseCtxStatus(raw);
                        setStatus(parsed);
                        setFetchFailed(parsed === undefined);
                    })
                    .catch(() => {
                        if (!cancelled) setFetchFailed(true);
                    });
            };
            load();
            const timer: ReturnType<typeof setInterval> = setInterval(load, CTX_POLL_MS);
            return () => {
                cancelled = true;
                clearInterval(timer);
            };
        }, [origin, reloadTick]);
        const lang = t("nav") === zhDict.nav ? "zh" : "en";
        const hintP = (key: string): unknown => createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t(key));
        const renderCard = (view: CtxView): unknown => {
            const pctOfLimit = view.limit !== null && view.limit > 0 ? Math.round((view.sentTotal / view.limit) * 100) : null;
            const anchorKindKey = view.anchor !== null ? ANCHOR_KIND_KEYS[view.anchor.kind] : undefined;
            const events: Array<{ at: number; head: string; detail: string }> = [];
            for (const f of view.folds) {
                const saved = f.savedSoFar > 0 ? ` · ${t("ctx_saved")} ${fmtTok(f.savedSoFar)}` : "";
                events.push({ at: f.at, head: `${t("ctx_fold")} #${f.seq}`, detail: `−${fmtTok(f.s)} → σ ${fmtTok(f.sigma)} · ${t("ctx_reclaimed")} ${fmtTok(f.reclaimed)}${saved}` });
            }
            for (const s of view.switches) {
                const key = SWITCH_KEYS[s.dim];
                if (key === undefined) continue;
                const attr = s.attributed > 0 ? ` · ~${fmtTok(s.attributed)}` : "";
                events.push({ at: s.at, head: t(key), detail: `${s.from ?? "?"} → ${s.to}${attr}` });
            }
            events.sort((a, b) => b.at - a.at);
            return createElement(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 10 } },
                fetchFailed ? createElement("p", { style: { margin: 0, opacity: 0.6, fontSize: 12 } }, t("ctx_stale_data")) : null,
                createElement(
                    "div",
                    { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" } },
                    createElement(
                        "div",
                        null,
                        createElement("div", { style: { fontSize: 18, fontWeight: 600 } }, `${fmtTok(view.sentTotal)} / ${view.limit !== null ? fmtTok(view.limit) : "—"}${pctOfLimit !== null ? ` (${pctOfLimit}%)` : ""}`),
                        createElement("p", { style: { margin: 0, opacity: 0.7, fontSize: 12 } }, t("ctx_sent")),
                    ),
                    view.anchor !== null
                        ? createElement("span", { style: { opacity: 0.85, fontSize: 13 } }, `${t("ctx_anchor")} ${fmtTok(view.anchor.tokens)} · ${anchorKindKey !== undefined ? t(anchorKindKey) : view.anchor.kind}`)
                        : null,
                ),
                createElement(
                    "div",
                    { style: { display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: "rgba(127,127,127,0.18)" } },
                    view.categories.map((c) =>
                        createElement("div", {
                            key: c.key,
                            title: `${categoryLabel(c.key, t)}: ${fmtTok(c.tokens)} (${c.pct}%)`,
                            style: { width: `${c.tokens > 0 ? Math.max(c.pct, 1.5) : 0}%`, height: "100%", background: categoryColor(c.key) },
                        }),
                    ),
                ),
                createElement(
                    "div",
                    { style: { display: "flex", flexDirection: "column", gap: 4 } },
                    view.categories.map((c) =>
                        createElement(
                            "div",
                            { key: c.key, style: { display: "flex", alignItems: "center", gap: 8, fontSize: 13 } },
                            createElement("span", { style: { width: 10, height: 10, borderRadius: 2, background: categoryColor(c.key), flexShrink: 0 } }),
                            createElement("span", { style: { flex: 1 } }, categoryLabel(c.key, t)),
                            createElement("span", { style: { opacity: 0.85 } }, `${fmtTok(c.tokens)} (${c.pct}%)`),
                        ),
                    ),
                ),
                createElement(
                    "div",
                    { style: { display: "flex", flexDirection: "column", gap: 6 } },
                    createElement("div", { style: { fontSize: 13, fontWeight: 600, opacity: 0.85 } }, t("ctx_events")),
                    events.length === 0
                        ? createElement("p", { style: { margin: 0, opacity: 0.6, fontSize: 13 } }, t("ctx_empty_events"))
                        : events.slice(0, CTX_EVENT_ROWS).map((e, i) =>
                            createElement(
                                "div",
                                { key: i, style: { display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12, alignItems: "baseline" } },
                                createElement("span", { style: { opacity: 0.7 } }, `${fmtTime(e.at, lang)}  ${e.head}`),
                                createElement("span", { style: { opacity: 0.85 } }, e.detail),
                            ),
                        ),
                ),
                createElement("p", { style: { margin: 0, opacity: 0.55, fontSize: 12, lineHeight: 1.6 } }, t("ctx_hint")),
            );
        };
        let middle: unknown;
        if (origin === undefined) {
            middle = hintP("degraded");
        } else if (status?.ok === true && status.phase === "pre-first-request") {
            middle = hintP("ctx_waiting");
        } else if (status?.ok === true && status.contextView === null) {
            // chain-advisory (#1357) also answers with a panel string but is NOT
            // a stale running build — read it as not-yet, never as "restart fixes
            // it".
            middle = hintP(status.panelPresent && status.phase !== "chain-advisory" ? "ctx_stale" : "ctx_nodata");
        } else if (status === undefined) {
            middle = hintP(fetchFailed ? "degraded" : "connecting");
        } else if (!status.ok) {
            middle = hintP("ctx_nodata");
        } else {
            middle = renderCard(status.contextView!);
        }
        return createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 12, padding: "20px 8px" } },
            middle,
            createElement(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
                origin !== undefined
                    ? createElement(
                        "button",
                        {
                            type: "button",
                            onClick: () => setReloadTick((x) => x + 1),
                            style: { cursor: "pointer", borderRadius: 8, border: "1px solid rgba(127,127,127,0.4)", background: "transparent", color: "inherit", fontFamily: "inherit", fontSize: 13, lineHeight: "20px", padding: "4px 14px" },
                        },
                        t("ctx_refresh"),
                    )
                    : null,
                openWebButton(origin, t, { fontSize: "13", lineHeight: "20px", padding: "4px 14px" }),
            ),
        );
    };
    const panel = (titled: boolean): ((props: Record<string, unknown>) => unknown) => () => {
        const [origin, setOrigin] = useState<string | undefined>(readOrigin());
        const [page, setPage] = useState<PageId>("overview");
        // #2559: synchronous first paint — the very first render already pins
        // the palette to the host's current ground (no wrong-scheme flash).
        const [theme, setTheme] = useState<("light" | "dark") | undefined>(detectHostTheme);
        // #3100: embed pre-flight verdict for the CURRENT origin — a verdict
        // recorded for a previous origin (mid-session re-bind) is stale by
        // definition and reads as "pending" until its own probe lands.
        const [embed, setEmbed] = useState<EmbedState | undefined>(() => {
            const o = readOrigin();
            const v = o !== undefined ? embedVerdicts.get(o) : undefined;
            return o !== undefined && v !== undefined ? { origin: o, verdict: v } : undefined;
        });
        // #2288: no guard on the snapshot — the live route is authoritative
        // for the whole mount, so a stale boot value is corrected in place.
        // #3100: each resolution also probes the new origin's embed route in
        // flight, and every tick re-drives pending origins (snapshot-only
        // hosts never resolve through this path again after mount).
        useEffect(
            () =>
                probeOrigin(
                    (o) => {
                        setOrigin(o);
                        probeEmbedRoute(o, setEmbed);
                    },
                    setTheme,
                    (o) => probeEmbedRoute(o, setEmbed),
                ),
            [],
        );
        // #3100: mount-time probe for a snapshot origin and re-probe on any
        // origin change (covers hosts whose live route never answers).
        useEffect(() => {
            if (origin !== undefined) probeEmbedRoute(origin, setEmbed);
        }, [origin]);
        const liveEmbed: EmbedVerdict | undefined = embed !== undefined && embed.origin === origin ? embed.verdict : undefined;
        // #3816: remote page + loopback origin ⇒ unreachable by construction —
        // explain the fix instead of spinning on "connecting…". ANY resolved
        // verdict outranks the mismatch: a verdict means THIS browser actually
        // reached the origin (same-machine access through a LAN IP still
        // reaches the loopback) — never shadow a working frame or the stale
        // notice of a reachable-but-frozen proxy.
        const remoteBlocked = remoteMismatch(origin) && liveEmbed === undefined;
        const lang = t("nav") === zhDict.nav ? "zh" : "en";
        let middle: unknown;
        if (origin === undefined) {
            middle = createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("degraded"));
        } else if (remoteBlocked && origin !== undefined) {
            // The jump button targets the panel's config page (#/config) in a
            // fresh tab. For a purely remote browser that address is still
            // unreachable — the file-edit text above is the primary route;
            // the button serves same-LAN/tunneled access where it lands on
            // the exact field to set.
            const cfgUrl = `${origin}/__bili/#/config`;
            middle = createElement(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" } },
                createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("remote_blocked")),
                createElement(
                    "code",
                    {
                        style: {
                            display: "block",
                            padding: "6px 10px",
                            borderRadius: 8,
                            border: "1px solid rgba(127,127,127,0.4)",
                            background: "rgba(127,127,127,0.08)",
                            fontSize: 13,
                            lineHeight: 1.6,
                        },
                    },
                    REMOTE_RELAY_SNIPPET,
                ),
                createElement(
                    "button",
                    { type: "button", title: cfgUrl, onClick: () => openExternal(cfgUrl), style: ACTION_BTN_STYLE },
                    t("remote_open_config"),
                ),
            );
        } else if (liveEmbed === "stale") {
            middle = createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("stale"));
        } else if (liveEmbed === "ok") {
            middle = createElement(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 10 } },
                createElement(
                    "div",
                    { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
                    PAGE_IDS.map((id) =>
                        createElement(
                            "button",
                            {
                                key: id,
                                type: "button",
                                onClick: () => setPage(id),
                                style: {
                                    cursor: "pointer",
                                    borderRadius: 8,
                                    border: id === page ? "1px solid rgba(127,127,127,0.7)" : "1px solid rgba(127,127,127,0.4)",
                                    background: id === page ? "rgba(127,127,127,0.12)" : "transparent",
                                    color: "inherit",
                                    fontFamily: "inherit",
                                    fontSize: 13,
                                    fontWeight: id === page ? 600 : 400,
                                    lineHeight: "20px",
                                    padding: "4px 14px",
                                },
                            },
                            t(PAGE_KEYS[id]),
                        ),
                    ),
                    // The open-in-browser action rides the TAB row — right
                    // after the logs tab, pushed to the row's far end —
                    // instead of sitting in the footer below the iframe.
                    openWebButton(origin, t, { marginLeft: "auto", fontSize: "13", lineHeight: "20px", padding: "4px 14px" }),
                ),
                createElement("iframe", {
                    src: `${origin}/__bili/?embed=1&lang=${lang}${theme ? `&theme=${theme}` : ""}#/${page}`,
                    title: t("title"),
                    style: {
                        display: "block",
                        width: "100%",
                        height: EMBED_HEIGHT,
                        border: "1px solid rgba(127,127,127,0.4)",
                        borderRadius: 8,
                        background: "transparent",
                    },
                }),
            );
        } else {
            middle = createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("connecting"));
        }
        return createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 12, padding: "20px 8px" } },
            titled ? createElement("h3", { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, t("title")) : null,
            middle,
            createElement(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
                createElement("p", { style: { margin: 0, opacity: 0.7, fontSize: 13, lineHeight: 1.6, flex: 1, minWidth: 200 } }, t("hint")),
                // ok 状态:按钮在上方页签行(日志页签后面);degraded/stale
                // 仍留在页脚作后备入口(#2448 同一按钮)。#3816: remoteBlocked
                // 时按钮指向的正是那个够不到的回环地址——死链,一并隐藏。
                liveEmbed === "ok" || remoteBlocked ? null : openWebButton(origin, t),
            ),
        );
    };
    ctx.slots.inject(
        "settings.section",
        () => ctx.slots.register({ name: "settings.section", id: "bili", order: 100, label: () => t("nav"), locale: NS }, panel(true)),
    );
    ctx.slots.inject(
        "plugins.bundle.config",
        () => ctx.slots.register({ name: "plugins.bundle.config", key: "billion-context", locale: NS }, panel(false)),
    );
    // #3862: session Context tab. order 30 sits right of the built-in chat (0)
    // and trajectory (10) tabs and right of dsh-context's Context tab (20)
    // when both are installed. Deferred injection is fail-open on hosts whose
    // build lacks the slot.
    ctx.slots.inject(
        "conversation.view",
        () => ctx.slots.register({ name: "conversation.view", id: "bili-context", order: 30, label: () => t("tab_ctx"), locale: NS }, contextPanel()),
    );
}
