import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createAssistantMessageEventStream, } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
const PROVIDER_ID = "model-auto-router";
const ROUTES_PATH = join(homedir(), ".pi", "agent", "extensions", "model-auto-router.routes.json");
const PROJECT_ROUTES_PATH = ".pi/model-auto-router.routes.json";
const STATE_PATH = join(homedir(), ".pi", "agent", "model-auto-router.db");
const MODELS_JSON_PATH = join(homedir(), ".pi", "agent", "models.json");
const LOG_MAX_LINES = 2000;
const LOG_MAX_BYTES = 256 * 1024;
const TRANSIENT_COOLDOWN_MS = 60_000;
const LONG_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const TRANSIENT_BACKOFF_BASE_MS = 2_000;
const TRANSIENT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const defaultDeps = {
    createStream: createAssistantMessageEventStream,
    streamSimple,
    now: () => Date.now(),
    sleep: sleepImpl,
};
let routesConfig = { routes: {} };
let routesCacheMtime;
let routesCachePath;
let modelsJsonCache;
let db = null;
let DatabaseSync;
let activeTargetLabel;
let routerWaitState;
let currentRunSummary;
let lastRunSummary;
let statusTick;
let statusTickRouteId;
let onStatusUpdate;
let onNotify;
let selectionClock = 0;
const cooldowns = new Map();
const cooldownReasons = new Map();
const runtimeState = new Map();
export const AUTO_ROUTER_SUBCOMMANDS = [
    { value: "status", label: "status", description: "routes, target load, cooldowns, and failures" },
    { value: "log", label: "log [N]", description: "recent routing and failover events" },
    { value: "reset", label: "reset", description: "clear cooldowns and runtime counters" },
    { value: "reload", label: "reload", description: "reload routes and hidden providers" },
    { value: "debug", label: "debug", description: "list registry models" },
];
function loadRoutes() {
    const paths = [PROJECT_ROUTES_PATH, ROUTES_PATH];
    for (const p of paths) {
        if (!existsSync(p))
            continue;
        try {
            const mtime = statSync(p).mtimeMs;
            if (routesCachePath === p && routesCacheMtime === mtime)
                return;
            routesConfig = normalizeConfig(JSON.parse(readFileSync(p, "utf-8")));
            routesCachePath = p;
            routesCacheMtime = mtime;
            return;
        }
        catch { }
    }
    routesConfig = { routes: {} };
    routesCachePath = undefined;
    routesCacheMtime = undefined;
}
function normalizeConfig(value) {
    const cfg = value && typeof value === "object" ? value : { routes: {} };
    return { routes: cfg.routes ?? {}, hide: cfg.hide ?? [], show: cfg.show ?? [] };
}
function targetKey(target) {
    return `${target.provider}/${target.model}`;
}
function stateFor(target) {
    const key = targetKey(target);
    let state = runtimeState.get(key);
    if (!state) {
        state = { active: 0, picked: 0, failures: 0, successes: 0 };
        runtimeState.set(key, state);
    }
    return state;
}
function formatDuration(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
}
function stopStatusTicker() {
    if (!statusTick)
        return;
    clearInterval(statusTick);
    statusTick = undefined;
    statusTickRouteId = undefined;
}
function addWaitDuration(state, elapsedMs) {
    if (!currentRunSummary)
        return;
    if (state.kind === "api-wait")
        currentRunSummary.apiWaitMs += elapsedMs;
    if (state.kind === "streaming")
        currentRunSummary.streamingMs += elapsedMs;
    if (state.kind === "retry-backoff")
        currentRunSummary.retryBackoffMs += elapsedMs;
}
function setRouterWaitState(state, routeId) {
    if (routerWaitState)
        addWaitDuration(routerWaitState, Date.now() - routerWaitState.startedAt);
    routerWaitState = state;
    if (state?.kind === "api-wait" || state?.kind === "streaming") {
        if (currentRunSummary)
            currentRunSummary.lastTarget = state.target;
    }
    if (state) {
        statusTickRouteId = routeId;
        if (!statusTick) {
            statusTick = setInterval(() => onStatusUpdate?.(statusTickRouteId), 1000);
            statusTick.unref?.();
        }
    }
    else {
        stopStatusTicker();
    }
    onStatusUpdate?.(routeId);
}
function finishRunSummary(routeId, status, failovers) {
    if (!currentRunSummary)
        return;
    currentRunSummary.status = status;
    currentRunSummary.failovers = failovers;
    lastRunSummary = { ...currentRunSummary };
    currentRunSummary = undefined;
    onStatusUpdate?.(routeId);
}
function maxTransientRetries() {
    const raw = process.env.MODEL_AUTO_ROUTER_MAX_RETRIES;
    if (raw === undefined || raw === "")
        return DEFAULT_MAX_RETRIES;
    const value = parseInt(raw, 10);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MAX_RETRIES;
}
function backoffDelay(attempt) {
    return Math.min(TRANSIENT_BACKOFF_BASE_MS * 2 ** attempt, TRANSIENT_BACKOFF_MAX_MS);
}
function sleepImpl(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted)
            return resolve(false);
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve(true);
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve(false);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
function isOnCooldown(target) {
    const until = cooldowns.get(targetKey(target));
    return !!until && until > Date.now();
}
function getAvailableTargets(routeId) {
    const route = routesConfig.routes[routeId];
    if (!route)
        return [];
    return (route.targets ?? []).filter((target) => {
        if (isOnCooldown(target))
            return false;
        const max = target.maxConcurrency;
        return max === undefined || stateFor(target).active < max;
    });
}
function rankTargets(routeId, tried = new Set()) {
    const route = routesConfig.routes[routeId];
    const available = getAvailableTargets(routeId).filter((target) => !tried.has(targetKey(target)));
    if (route?.strategy === "cache-first") {
        return available;
    }
    if (route?.strategy === "round-robin") {
        return available.sort((a, b) => stateFor(a).picked - stateFor(b).picked || targetKey(a).localeCompare(targetKey(b)));
    }
    return available.sort((a, b) => {
        const sa = stateFor(a);
        const sb = stateFor(b);
        const wa = Math.max(a.weight ?? 1, 0.001);
        const wb = Math.max(b.weight ?? 1, 0.001);
        const scoreA = sa.active / wa + sa.failures * 0.05;
        const scoreB = sb.active / wb + sb.failures * 0.05;
        return scoreA - scoreB || sa.picked - sb.picked || targetKey(a).localeCompare(targetKey(b));
    });
}
const QUOTA_MARKERS = [
    "402",
    "payment required",
    "balance insufficient",
    "insufficient balance",
    "credits exhausted",
    "out of credit",
    "account suspended",
    "account deactivated",
];
const CONFIG_MARKERS = [
    "model not found",
    "model_not_found",
    "does not exist",
    "unknown model",
    "invalid model",
    "no such model",
    "404",
];
const TRANSIENT_MARKERS = [
    "429",
    "throttling",
    "throttle",
    "rate limit",
    "ratelimit",
    "error_finish",
    "too many requests",
    "too many tokens",
    "overloaded",
    "over capacity",
    "capacity",
    "temporarily unavailable",
    "timeout",
    "timed out",
    "econnreset",
    "etimedout",
    "econnrefused",
    "enotfound",
    "socket hang up",
    "fetch failed",
    "connection reset",
    "connection refused",
    "connection closed",
    "network",
    "502",
    "503",
    "504",
    "bad gateway",
    "service unavailable",
    "gateway timeout",
    "internal server error",
    "quota",
];
export function parseSseErrorJson(message) {
    const trimmed = message.trim();
    if (trimmed.startsWith("{")) {
        try {
            const outer = JSON.parse(trimmed);
            const inner = (outer.error ?? outer);
            if (inner && typeof inner.message === "string") {
                const nested = parseSseErrorJson(inner.message);
                if (nested)
                    return nested;
                const code = typeof inner.code === "string" ? inner.code : "";
                if (code && code !== "upstream_error")
                    return inner;
            }
            return inner;
        }
        catch { }
    }
    const idx = message.indexOf("data:");
    if (idx < 0)
        return undefined;
    const nl = message.indexOf("\n", idx);
    const line = message.slice(idx + 5, nl === -1 ? undefined : nl).trim();
    if (!line.startsWith("{"))
        return undefined;
    try {
        return JSON.parse(line);
    }
    catch {
        return undefined;
    }
}
export function cleanErrorMessage(message) {
    const payload = parseSseErrorJson(message);
    if (payload && typeof payload.message === "string") {
        const code = typeof payload.code === "string" && payload.code ? `${payload.code}:` : "";
        return `${code}${payload.message}`.trim();
    }
    return message;
}
export function classifyFailure(message) {
    const payload = parseSseErrorJson(message);
    const code = typeof payload?.code === "string" ? payload.code.toLowerCase() : undefined;
    if (code && code.startsWith("throttling"))
        return "transient";
    if (code && (code.includes("rate_limit") || code.includes("ratelimit")))
        return "transient";
    const text = message.toLowerCase();
    if (QUOTA_MARKERS.some((marker) => text.includes(marker)))
        return "quota";
    if (CONFIG_MARKERS.some((marker) => text.includes(marker)))
        return "config";
    if (/(^|\D)(401|403)(\D|$)/.test(text) || /unauthori[sz]ed|forbidden|invalid (api )?key|authentication failed/.test(text)) {
        return "config";
    }
    if (TRANSIENT_MARKERS.some((marker) => text.includes(marker)))
        return "transient";
    return "fatal";
}
export function retryableTransientMessage(rawMessage) {
    const payload = parseSseErrorJson(rawMessage);
    const code = typeof payload?.code === "string" && payload.code ? payload.code : "transient error";
    return `[model-auto-router] 429 rate limit mid-stream (${code}): provider throttling, transient`;
}
function getLogPath() {
    return process.env.MODEL_AUTO_ROUTER_LOG_PATH ?? join(homedir(), ".pi", "agent", "model-auto-router.log");
}
function logEvent(ev) {
    if (process.env.MODEL_AUTO_ROUTER_LOG === "off")
        return;
    try {
        appendFileSync(getLogPath(), JSON.stringify({ ts: new Date().toISOString(), ...ev }) + "\n");
        maybeRotateLog();
    }
    catch { }
}
function maybeRotateLog() {
    try {
        const path = getLogPath();
        if (statSync(path).size < LOG_MAX_BYTES)
            return;
        const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
        writeFileSync(path, lines.slice(-LOG_MAX_LINES).join("\n") + "\n");
    }
    catch { }
}
export function readLogTail(n) {
    try {
        const lines = readFileSync(getLogPath(), "utf-8").split("\n").filter(Boolean);
        const out = [];
        for (const line of lines.slice(-n)) {
            try {
                out.push(JSON.parse(line));
            }
            catch { }
        }
        return out;
    }
    catch {
        return [];
    }
}
function getDb() {
    if (db)
        return db;
    try {
        if (!DatabaseSync) {
            const require = createRequire(import.meta.url);
            DatabaseSync = require("node:sqlite").DatabaseSync;
        }
        db = new DatabaseSync(STATE_PATH);
        db.exec("CREATE TABLE IF NOT EXISTS cooldowns (key TEXT PRIMARY KEY, until INTEGER NOT NULL)");
        const cols = db.prepare("PRAGMA table_info(cooldowns)").all();
        const names = new Set(cols.map((col) => col.name));
        for (const col of ["cls TEXT", "error TEXT", "at INTEGER"]) {
            const name = col.split(" ")[0];
            if (!names.has(name))
                db.exec(`ALTER TABLE cooldowns ADD COLUMN ${col}`);
        }
        return db;
    }
    catch {
        return undefined;
    }
}
function saveCooldowns() {
    const handle = getDb();
    if (!handle)
        return;
    try {
        handle.exec("DELETE FROM cooldowns");
        const stmt = handle.prepare("INSERT INTO cooldowns (key, until, cls, error, at) VALUES (?, ?, ?, ?, ?)");
        for (const [key, until] of cooldowns) {
            const reason = cooldownReasons.get(key);
            stmt.run(key, until, reason?.class ?? null, reason?.error ?? null, reason?.at ?? null);
        }
    }
    catch { }
}
function loadCooldowns(now = Date.now()) {
    const handle = getDb();
    if (!handle)
        return;
    try {
        const rows = handle.prepare("SELECT key, until, cls, error, at FROM cooldowns WHERE until > ?").all(now);
        for (const row of rows) {
            cooldowns.set(row.key, row.until);
            if (row.cls || row.error) {
                cooldownReasons.set(row.key, {
                    class: row.cls ?? "transient",
                    error: row.error ?? "",
                    at: row.at ?? now,
                });
            }
        }
        handle.prepare("DELETE FROM cooldowns WHERE until <= ?").run(now);
    }
    catch { }
}
function putOnCooldown(target, cls, error) {
    const duration = cls === "transient" ? TRANSIENT_COOLDOWN_MS : LONG_COOLDOWN_MS;
    const key = targetKey(target);
    const now = Date.now();
    cooldowns.set(key, now + duration);
    cooldownReasons.set(key, { class: cls, error, at: now });
    saveCooldowns();
}
function stripJsonComments(text) {
    let out = "";
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const ch = text[i];
        if (inString) {
            out += ch;
            if (ch === "\\") {
                out += text[i + 1] ?? "";
                i += 2;
                continue;
            }
            if (ch === '"')
                inString = false;
            i++;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            i++;
            continue;
        }
        if (ch === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n")
                i++;
            continue;
        }
        if (ch === "/" && text[i + 1] === "*") {
            i += 2;
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
                i++;
            i += 2;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}
function stripTrailingCommas(text) {
    let out = "";
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const ch = text[i];
        if (inString) {
            out += ch;
            if (ch === "\\") {
                out += text[i + 1] ?? "";
                i += 2;
                continue;
            }
            if (ch === '"')
                inString = false;
            i++;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            i++;
            continue;
        }
        if (ch === ",") {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j]))
                j++;
            if (text[j] === "}" || text[j] === "]") {
                i++;
                continue;
            }
        }
        out += ch;
        i++;
    }
    return out;
}
export function stripJsonc(text) {
    return stripTrailingCommas(stripJsonComments(text));
}
function readModelsJsonProviders() {
    try {
        const cfg = JSON.parse(stripJsonc(readFileSync(MODELS_JSON_PATH, "utf-8")));
        const providers = (cfg?.providers ?? {});
        const mtimeMs = statSync(MODELS_JSON_PATH).mtimeMs;
        modelsJsonCache = { mtimeMs, providers };
        return providers;
    }
    catch {
        return modelsJsonCache?.providers ?? {};
    }
}
function getModelsJsonProviders() {
    try {
        const mtimeMs = statSync(MODELS_JSON_PATH).mtimeMs;
        if (modelsJsonCache && modelsJsonCache.mtimeMs === mtimeMs)
            return modelsJsonCache.providers;
    }
    catch { }
    return readModelsJsonProviders();
}
function getModelsJsonProvider(providerId) {
    const cached = getModelsJsonProviders()[providerId];
    if (cached)
        return cached;
    return readModelsJsonProviders()[providerId];
}
export function resolveConfigValue(raw) {
    if (typeof raw !== "string" || raw.length === 0)
        return undefined;
    if (raw.startsWith("!"))
        return undefined;
    const direct = raw.match(/^\$\{(\w+)\}$/) ?? raw.match(/^\$(\w+)$/);
    if (direct)
        return process.env[direct[1]];
    if (raw.includes("$")) {
        return raw.replace(/\$\{(\w+)\}|\$(\w+)/g, (_s, a, b) => process.env[a ?? b] ?? "");
    }
    return raw;
}
function resolveApiKey(target) {
    const upper = target.provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    return process.env[`${upper}_AUTH_TOKEN`] ?? process.env[`${upper}_API_KEY`] ?? resolveConfigValue(getModelsJsonProvider(target.provider)?.apiKey);
}
function defaultCompatForTarget(target, api, baseUrl) {
    if (api !== "openai-completions")
        return undefined;
    const lowerBaseUrl = baseUrl.toLowerCase();
    if (lowerBaseUrl.includes("dashscope.aliyuncs.com")
        || lowerBaseUrl.includes("maas.aliyuncs.com")
        || lowerBaseUrl.includes("open.bigmodel.cn")
        || target.provider === "alibaba"
        || target.provider === "tokenplan"
        || target.provider === "zhipu") {
        return { supportsDeveloperRole: false };
    }
    return undefined;
}
function buildModel(target) {
    const provider = getModelsJsonProvider(target.provider);
    const model = provider?.models?.find((entry) => entry.id === target.model);
    const api = (target.api ?? model?.api ?? provider?.api ?? target.provider);
    const baseUrl = target.baseUrl ?? provider?.baseUrl ?? process.env[`${target.provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BASE_URL`] ?? target.provider;
    const compat = {
        ...defaultCompatForTarget(target, api, baseUrl),
        ...provider?.compat,
        ...model?.compat,
        ...target.compat,
    };
    return {
        id: target.model,
        name: model?.name ?? target.model,
        provider: target.provider,
        api,
        baseUrl,
        reasoning: model?.reasoning ?? false,
        input: model?.input ?? ["text"],
        compat: Object.keys(compat).length > 0 ? compat : undefined,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: target.contextWindow ?? model?.contextWindow ?? 400_000,
        maxTokens: target.maxTokens ?? model?.maxTokens ?? 16_384,
    };
}
function routeModelMeta(route) {
    const metas = (route.targets ?? []).map(buildModel);
    if (metas.length === 0)
        return { contextWindow: 400_000, maxTokens: 16_384, reasoning: false, input: ["text"] };
    return {
        contextWindow: Math.min(...metas.map((model) => model.contextWindow || 400_000)),
        maxTokens: Math.min(...metas.map((model) => model.maxTokens || 16_384)),
        reasoning: metas.some((model) => model.reasoning),
        input: metas.every((model) => model.input?.includes("image")) ? ["text", "image"] : ["text"],
    };
}
function zeroUsage() {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}
function pushError(stream, model, message, reason = "error") {
    stream.push({
        type: "error",
        reason,
        error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: zeroUsage(),
            stopReason: reason,
            errorMessage: reason === "error" ? message : undefined,
            timestamp: Date.now(),
        },
    });
}
function isCommitEvent(event) {
    return event.type === "text_start" || event.type === "thinking_start" || event.type === "toolcall_start" || event.type === "done";
}
function streamWithAutoRouter(deps, model, context, options) {
    const routeId = model.id;
    const signal = options?.signal;
    loadRoutes();
    if (getAvailableTargets(routeId).length === 0) {
        logEvent({ event: "no-targets", route: routeId });
        const stream = deps.createStream();
        const routeDef = routesConfig.routes[routeId];
        const now = deps.now();
        const cooldownInfo = routeDef?.targets
            ?.map((target) => {
            const key = targetKey(target);
            const until = cooldowns.get(key);
            if (!until || until <= now)
                return null;
            const reason = cooldownReasons.get(key);
            const remaining = Math.ceil((until - now) / 1000);
            return `- ${key}: ${reason?.class ?? "?"} (${remaining}s remaining${reason?.error ? `: ${reason.error}` : ""})`;
        })
            .filter(Boolean)
            .join("\n");
        pushError(stream, model, `[model-auto-router] No available targets for route "${routeId}".\n\n${cooldownInfo || "No targets configured."}\n\nRun /auto-router reset to clear cooldowns.`);
        return stream;
    }
    const outer = deps.createStream();
    void (async () => {
        currentRunSummary = {
            routeId,
            status: "failed",
            apiWaitMs: 0,
            streamingMs: 0,
            retryBackoffMs: 0,
            failovers: 0,
        };
        const maxRetries = maxTransientRetries();
        const transientFailures = new Map();
        let failovers = 0;
        let pass = 0;
        while (true) {
            if (signal?.aborted) {
                pushError(outer, model, "aborted", "aborted");
                activeTargetLabel = undefined;
                setRouterWaitState(undefined, routeId);
                finishRunSummary(routeId, "aborted", failovers);
                return;
            }
            const tried = new Set();
            let selected = rankTargets(routeId, tried)[0];
            while (selected) {
                const key = targetKey(selected);
                tried.add(key);
                const selectedState = stateFor(selected);
                selectedState.active++;
                selectedState.picked = ++selectionClock;
                activeTargetLabel = key;
                setRouterWaitState({ kind: "api-wait", target: key, startedAt: deps.now() }, routeId);
                logEvent({ event: "selected", route: routeId, target: key, active: selectedState.active, pass });
                let committed = false;
                const buffered = [];
                try {
                    const streamOptions = { ...options };
                    const apiKey = resolveApiKey(selected);
                    if (apiKey)
                        streamOptions.headers = { ...streamOptions.headers, Authorization: `Bearer ${apiKey}` };
                    for await (const event of deps.streamSimple(buildModel(selected), context, streamOptions)) {
                        if (signal?.aborted && !committed) {
                            pushError(outer, model, "aborted", "aborted");
                            setRouterWaitState(undefined, routeId);
                            finishRunSummary(routeId, "aborted", failovers);
                            return;
                        }
                        if (event.type === "error" && !committed) {
                            const rawMessage = event.error.errorMessage ?? "unknown error";
                            const cls = classifyFailure(rawMessage);
                            const error = cleanErrorMessage(rawMessage);
                            selectedState.failures++;
                            if (cls === "fatal") {
                                logEvent({ event: "fatal", route: routeId, target: key, error });
                                pushError(outer, model, error);
                                setRouterWaitState(undefined, routeId);
                                finishRunSummary(routeId, "failed", failovers);
                                return;
                            }
                            failovers++;
                            const next = rankTargets(routeId, tried)[0];
                            logEvent({ event: "failover", route: routeId, target: key, class: cls, error, next: next ? targetKey(next) : undefined, pass });
                            if (cls === "transient") {
                                transientFailures.set(key, { target: selected, error });
                            }
                            else {
                                putOnCooldown(selected, cls, error);
                            }
                            if (next)
                                onNotify?.(`[auto-router] ${key} failed (${cls}), trying ${targetKey(next)}`, "info");
                            break;
                        }
                        if (!committed) {
                            buffered.push(event);
                            if (isCommitEvent(event)) {
                                committed = true;
                                setRouterWaitState({ kind: "streaming", target: key, startedAt: deps.now() }, routeId);
                                selectedState.successes++;
                                for (const bufferedEvent of buffered)
                                    outer.push(bufferedEvent);
                                logEvent({ event: "served", route: routeId, target: key, failovers, pass });
                            }
                        }
                        else {
                            if (event.type === "error" && classifyFailure(event.error.errorMessage ?? "") === "transient") {
                                logEvent({ event: "failover", route: routeId, target: key, class: "transient", pass, error: `mid-stream transient error: ${cleanErrorMessage(event.error.errorMessage ?? "")}` });
                                outer.push({ ...event, error: { ...event.error, errorMessage: retryableTransientMessage(event.error.errorMessage ?? "") } });
                            }
                            else {
                                outer.push(event);
                            }
                        }
                    }
                }
                catch (err) {
                    const rawMessage = err instanceof Error ? err.message : String(err);
                    const cls = classifyFailure(rawMessage);
                    const error = cleanErrorMessage(rawMessage);
                    selectedState.failures++;
                    if (cls === "fatal") {
                        logEvent({ event: "fatal", route: routeId, target: key, error });
                        pushError(outer, model, error);
                        setRouterWaitState(undefined, routeId);
                        finishRunSummary(routeId, "failed", failovers);
                        return;
                    }
                    failovers++;
                    if (cls === "transient")
                        transientFailures.set(key, { target: selected, error });
                    else
                        putOnCooldown(selected, cls, error);
                    logEvent({ event: "failover", route: routeId, target: key, class: cls, error, pass });
                }
                finally {
                    selectedState.active = Math.max(0, selectedState.active - 1);
                    activeTargetLabel = undefined;
                    setRouterWaitState(undefined, routeId);
                }
                if (committed) {
                    finishRunSummary(routeId, "served", failovers);
                    return;
                }
                selected = rankTargets(routeId, tried)[0];
            }
            const retryable = [...transientFailures.keys()].filter((key) => {
                const until = cooldowns.get(key);
                return !until || until <= deps.now();
            });
            if (retryable.length === 0 || pass >= maxRetries)
                break;
            const delay = backoffDelay(pass);
            activeTargetLabel = undefined;
            setRouterWaitState({ kind: "retry-backoff", delayMs: delay, pass: pass + 1, maxRetries, startedAt: deps.now() }, routeId);
            logEvent({ event: "retry", route: routeId, pass: pass + 1, cooldownMs: delay, error: `all targets transient-failed (${retryable.length}), backing off ${delay}ms` });
            onNotify?.(`[auto-router] all targets throttled — retry ${pass + 1}/${maxRetries} in ${Math.round(delay / 1000)}s`, "warning");
            const completed = await deps.sleep(delay, signal);
            setRouterWaitState(undefined, routeId);
            if (!completed) {
                pushError(outer, model, "aborted", "aborted");
                finishRunSummary(routeId, "aborted", failovers);
                return;
            }
            pass++;
        }
        for (const { target, error } of transientFailures.values())
            putOnCooldown(target, "transient", error);
        const routeDef = routesConfig.routes[routeId];
        const summary = (routeDef?.targets ?? []).map((target) => {
            const reason = cooldownReasons.get(targetKey(target));
            return reason ? `${targetKey(target)}: ${reason.error}` : targetKey(target);
        }).join(" | ");
        logEvent({ event: "all-failed", route: routeId, error: summary, failovers, pass });
        pushError(outer, model, `[model-auto-router] All targets failed for "${routeId}"${pass > 0 ? ` after ${pass} retry pass${pass > 1 ? "es" : ""}` : ""}: ${summary}\n\nRun /auto-router reset to clear cooldowns.`);
        finishRunSummary(routeId, "failed", failovers);
    })();
    return outer;
}
function getHiddenProviderIds() {
    const shown = new Set(routesConfig.show ?? []);
    const ids = new Set();
    for (const id of routesConfig.hide ?? []) {
        if (id && id !== PROVIDER_ID && !shown.has(id))
            ids.add(id);
    }
    for (const route of Object.values(routesConfig.routes)) {
        for (const target of route.targets ?? []) {
            if (target.provider && target.provider !== PROVIDER_ID && !shown.has(target.provider))
                ids.add(target.provider);
        }
    }
    return ids;
}
function createStatusLine(routeId) {
    if (!routeId || !routesConfig.routes[routeId])
        return "auto-router: idle";
    const now = Date.now();
    const route = routesConfig.routes[routeId];
    const parts = (route.targets ?? []).map((target) => {
        const key = targetKey(target);
        const state = stateFor(target);
        const until = cooldowns.get(key);
        if (until && until > now)
            return `${key} ✗(${Math.ceil((until - now) / 1000)}s)`;
        const active = state.active > 0 ? ` active=${state.active}` : "";
        if (activeTargetLabel !== key)
            return `${key} ✓${active}`;
        const wait = routerWaitState?.kind === "api-wait" || routerWaitState?.kind === "streaming"
            ? ` ${routerWaitState.kind} ${formatDuration(now - routerWaitState.startedAt)}`
            : "";
        return `[${key} ✓${wait}${active}]`;
    });
    const state = routerWaitState?.kind === "retry-backoff"
        ? `  retry-backoff ${formatDuration(now - routerWaitState.startedAt)}/${formatDuration(routerWaitState.delayMs)} pass=${routerWaitState.pass}/${routerWaitState.maxRetries}`
        : "";
    const last = !state && !activeTargetLabel && lastRunSummary?.routeId === routeId
        ? `  last=${lastRunSummary.status}${lastRunSummary.lastTarget ? ` target=${lastRunSummary.lastTarget}` : ""} api-wait=${formatDuration(lastRunSummary.apiWaitMs)} streaming=${formatDuration(lastRunSummary.streamingMs)} retry-backoff=${formatDuration(lastRunSummary.retryBackoffMs)} failovers=${lastRunSummary.failovers}`
        : "";
    return `auto-router [${routeId}] ${parts.join("  ")}${state}${last}`;
}
function statusMarkdown() {
    loadRoutes();
    const lines = ["## Model Auto Router Routes", ""];
    for (const [id, route] of Object.entries(routesConfig.routes)) {
        lines.push(`**${id}** (${route.strategy ?? "least-loaded"}):`);
        for (const target of route.targets ?? []) {
            const key = targetKey(target);
            const state = stateFor(target);
            const until = cooldowns.get(key);
            let status = `active=${state.active}, picked=${state.picked}, ok=${state.successes}, failed=${state.failures}`;
            if (until && until > Date.now()) {
                const reason = cooldownReasons.get(key);
                status += `, cooldown=${Math.ceil((until - Date.now()) / 1000)}s`;
                if (reason)
                    status += `, ${reason.class}: ${reason.error}`;
            }
            lines.push(`- ${key} weight=${target.weight ?? 1} ${status}`);
        }
    }
    if (Object.keys(routesConfig.routes).length === 0) {
        lines.push("_No routes configured._ Create `~/.pi/agent/extensions/model-auto-router.routes.json` or `.pi/model-auto-router.routes.json`.");
    }
    return lines.join("\n");
}
function isSlashArgumentContextText(textBeforeCursor) {
    const text = textBeforeCursor.trimStart();
    return text.startsWith("/") && text.includes(" ");
}
export function createAutoRouterAutocompleteWrapper(current) {
    return {
        triggerCharacters: current.triggerCharacters,
        async getSuggestions(lines, cursorLine, cursorCol, options) {
            const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
            const trimmed = before.trimStart();
            if (trimmed === "/auto-router" || trimmed === "/router")
                return { items: AUTO_ROUTER_SUBCOMMANDS, prefix: before };
            if (options?.force && isSlashArgumentContextText(before)) {
                const res = await current.getSuggestions(lines, cursorLine, cursorCol, { ...options, force: false });
                if (res)
                    return res;
            }
            return current.getSuggestions(lines, cursorLine, cursorCol, options);
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
            const trimmed = prefix?.trimStart?.() ?? "";
            if (trimmed === "/auto-router" || trimmed === "/router") {
                const line = lines[cursorLine] ?? "";
                const beforePrefix = line.slice(0, cursorCol - prefix.length);
                const after = line.slice(cursorCol);
                const command = trimmed === "/router" ? "/router" : "/auto-router";
                const inserted = `${command} ${item.value}`;
                const newLines = [...lines];
                newLines[cursorLine] = `${beforePrefix}${inserted}${after}`;
                return { lines: newLines, cursorLine, cursorCol: beforePrefix.length + inserted.length };
            }
            return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },
        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
            const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
            if (isSlashArgumentContextText(before))
                return true;
            return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
        },
    };
}
export function createModelAutoRouterExtension(deps = {}) {
    const resolvedDeps = { ...defaultDeps, ...deps };
    const hiddenProviders = new Set();
    return function modelAutoRouter(pi) {
        loadRoutes();
        loadCooldowns();
        let latestCtx;
        function refreshStatus(routeId) {
            if (!latestCtx)
                return;
            try {
                const model = latestCtx.model;
                latestCtx.ui.setStatus("model-auto-router", model?.provider === PROVIDER_ID ? createStatusLine(routeId ?? model.id) : undefined);
            }
            catch { }
        }
        function register() {
            loadRoutes();
            pi.registerProvider(PROVIDER_ID, {
                name: "Model Auto Router",
                baseUrl: PROVIDER_ID,
                apiKey: PROVIDER_ID,
                api: "model-auto-router-api",
                models: Object.entries(routesConfig.routes).map(([routeId, route]) => {
                    const meta = routeModelMeta(route);
                    return {
                        id: routeId,
                        name: routeId,
                        reasoning: meta.reasoning,
                        input: meta.input,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextWindow: route.contextWindow ?? meta.contextWindow,
                        maxTokens: route.maxTokens ?? meta.maxTokens,
                    };
                }),
                streamSimple: (model, context, options) => streamWithAutoRouter(resolvedDeps, model, context, options),
            });
        }
        function hideTargetProviders() {
            loadRoutes();
            const wanted = getHiddenProviderIds();
            for (const id of wanted) {
                if (hiddenProviders.has(id))
                    continue;
                try {
                    pi.registerProvider(id, { models: [] });
                    hiddenProviders.add(id);
                }
                catch { }
            }
            for (const id of [...hiddenProviders]) {
                if (wanted.has(id))
                    continue;
                try {
                    pi.unregisterProvider(id);
                }
                catch { }
                hiddenProviders.delete(id);
            }
        }
        function registerArgumentAutocompleteFix(ctx) {
            if (typeof ctx.ui?.addAutocompleteProvider !== "function")
                return;
            ctx.ui.addAutocompleteProvider((current) => createAutoRouterAutocompleteWrapper(current));
        }
        async function commandHandler(args, ctx) {
            const sub = args.trim().split(/\s+/)[0] || "status";
            if (sub === "status" || sub === "routes") {
                ctx.ui.notify(statusMarkdown(), "info");
                return;
            }
            if (sub === "reset") {
                cooldowns.clear();
                cooldownReasons.clear();
                runtimeState.clear();
                saveCooldowns();
                logEvent({ event: "cooldown-reset" });
                latestCtx = ctx;
                refreshStatus();
                ctx.ui.notify("All model-auto-router cooldowns and runtime counters cleared.", "info");
                return;
            }
            if (sub === "reload") {
                register();
                hideTargetProviders();
                latestCtx = ctx;
                refreshStatus();
                ctx.ui.notify(`Routes reloaded. Hidden providers: ${[...hiddenProviders].join(", ") || "(none)"}`, "info");
                return;
            }
            if (sub === "debug") {
                const registry = ctx.modelRegistry;
                const available = typeof registry?.getAvailable === "function" ? await registry.getAvailable() : [];
                const sample = available.slice(0, 15).map((entry) => `${entry.provider}/${entry.id} api=${entry.api}`).join("\n");
                ctx.ui.notify(`Available models (${available.length} total):\n${sample}`, "info");
                return;
            }
            if (sub === "log") {
                const n = parseInt(args.trim().split(/\s+/)[1] ?? "20", 10) || 20;
                if (process.env.MODEL_AUTO_ROUTER_LOG === "off") {
                    ctx.ui.notify("Logging is disabled (MODEL_AUTO_ROUTER_LOG=off).", "info");
                    return;
                }
                const entries = readLogTail(n);
                if (entries.length === 0) {
                    ctx.ui.notify(`No log entries yet. (log: ${getLogPath()})`, "info");
                    return;
                }
                const lines = entries.map((entry) => {
                    const ts = entry.ts.replace("T", " ").replace(/\.\d+Z$/, "");
                    const parts = [ts, entry.event];
                    if (entry.target)
                        parts.push(entry.target);
                    if (entry.class)
                        parts.push(`[${entry.class}]`);
                    if (entry.error)
                        parts.push(`- ${entry.error}`);
                    if (entry.next)
                        parts.push(`-> ${entry.next}`);
                    if (typeof entry.active === "number")
                        parts.push(`active=${entry.active}`);
                    return parts.join(" ");
                });
                ctx.ui.notify(`## model-auto-router log (last ${entries.length})\n\n${lines.join("\n")}\n\n_log: ${getLogPath()}_`, "info");
                return;
            }
            ctx.ui.notify(`Unknown subcommand: ${sub}. Use: status, reset, reload, debug, log`, "error");
        }
        onStatusUpdate = refreshStatus;
        onNotify = (message, level) => {
            try {
                latestCtx?.ui?.notify(message, level);
            }
            catch { }
        };
        register();
        hideTargetProviders();
        pi.on("session_start", async (_event, ctx) => {
            latestCtx = ctx;
            activeTargetLabel = undefined;
            setRouterWaitState(undefined, ctx.model?.id ?? undefined);
            registerArgumentAutocompleteFix(ctx);
            refreshStatus();
        });
        pi.on("model_select", async (_event, ctx) => { latestCtx = ctx; refreshStatus(); });
        pi.on("agent_start", async (_event, ctx) => { latestCtx = ctx; refreshStatus(); });
        pi.on("agent_end", async (_event, ctx) => { latestCtx = ctx; refreshStatus(); });
        pi.registerCommand("auto-router", {
            description: "Model auto router: status, cooldowns, reset, reload, log",
            getArgumentCompletions: (prefix) => {
                const filtered = AUTO_ROUTER_SUBCOMMANDS.filter((sub) => sub.value.startsWith(prefix));
                return filtered.length > 0 ? filtered : null;
            },
            handler: commandHandler,
        });
        pi.registerCommand("router", {
            description: "Alias for /auto-router",
            getArgumentCompletions: (prefix) => {
                const filtered = AUTO_ROUTER_SUBCOMMANDS.filter((sub) => sub.value.startsWith(prefix));
                return filtered.length > 0 ? filtered : null;
            },
            handler: commandHandler,
        });
    };
}
export default createModelAutoRouterExtension();
export const __internals = {
    AUTO_ROUTER_SUBCOMMANDS,
    PROVIDER_ID,
    backoffDelay,
    classifyFailure,
    cleanErrorMessage,
    createAutoRouterAutocompleteWrapper,
    createModelAutoRouterExtension,
    getAvailableTargets,
    getHiddenProviderIds,
    getLogPath,
    maxTransientRetries,
    parseSseErrorJson,
    rankTargets,
    readLogTail,
    resolveConfigValue,
    retryableTransientMessage,
    routeModelMeta,
    runtimeState,
    stripJsonc,
};
//# sourceMappingURL=index.js.map