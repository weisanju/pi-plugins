import { createAssistantMessageEventStream, type Api } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export type RouteTarget = {
    provider: string;
    model: string;
    weight?: number;
    maxConcurrency?: number;
    api?: Api;
    baseUrl?: string;
    contextWindow?: number;
    maxTokens?: number;
    compat?: Record<string, unknown>;
};
export type RouteDefinition = {
    targets: RouteTarget[];
    strategy?: "cache-first" | "least-loaded" | "round-robin";
    contextWindow?: number;
    maxTokens?: number;
};
export type RetryConfig = {
    /** 所有目标瞬态失败后的整轮重试次数，0 = 禁用重试 */
    maxRetries?: number;
    /** 退避起始间隔 (ms)，每轮翻倍 */
    backoffBaseMs?: number;
    /** 退避等待上限 (ms) */
    backoffMaxMs?: number;
    /** 瞬态失败（限流/超时）后目标冷却时长 (ms) */
    transientCooldownMs?: number;
    /** quota/config 类失败后目标冷却时长 (ms) */
    longCooldownMs?: number;
};
export type RoutesConfig = {
    routes: Record<string, RouteDefinition>;
    hide?: string[];
    show?: string[];
    /** 重试与冷却设置（TUI 可配置），缺省回退到环境变量/内置默认值 */
    retry?: RetryConfig;
};
export type FailureClass = "transient" | "quota" | "config" | "fatal";
export type AutoRouterLogEvent = {
    ts: string;
    event: "selected" | "failover" | "retry" | "served" | "fatal" | "all-failed" | "no-targets" | "cooldown-reset";
    route?: string;
    target?: string;
    class?: FailureClass;
    error?: string;
    cooldownMs?: number;
    next?: string;
    failovers?: number;
    pass?: number;
    active?: number;
};
type TargetRuntimeState = {
    active: number;
    picked: number;
    failures: number;
    successes: number;
};
type Deps = {
    createStream: typeof createAssistantMessageEventStream;
    streamSimple: typeof streamSimple;
    now: () => number;
    sleep: (ms: number, signal?: AbortSignal) => Promise<boolean>;
};
export declare const AUTO_ROUTER_SUBCOMMANDS: Array<{
    value: string;
    label: string;
    description?: string;
}>;
declare function maxTransientRetries(): number;
declare function backoffDelay(attempt: number, retry?: RetryConfig): number;
/** 无事件判定挂起的最长等待（毫秒），env MODEL_AUTO_ROUTER_STALL_TIMEOUT_MS 可覆盖 */
export declare function stallTimeoutMs(): number;
declare function getAvailableTargets(routeId: string): RouteTarget[];
declare function rankTargets(routeId: string, tried?: Set<string>): RouteTarget[];
export declare function parseSseErrorJson(message: string): Record<string, unknown> | undefined;
export declare function cleanErrorMessage(message: string): string;
export declare function classifyFailure(message: string): FailureClass;
export declare function retryableTransientMessage(rawMessage: string): string;
declare function getLogPath(): string;
export declare function readLogTail(n: number): AutoRouterLogEvent[];
export declare function stripJsonc(text: string): string;
export declare function resolveConfigValue(raw: string | undefined): string | undefined;
type RouteModelMeta = {
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
    input: Array<"text" | "image">;
};
declare function routeModelMeta(route: RouteDefinition): RouteModelMeta;
declare function getHiddenProviderIds(): Set<string>;
export declare function createAutoRouterAutocompleteWrapper(current: any): any;
export declare function createModelAutoRouterExtension(deps?: Partial<Deps>): (pi: ExtensionAPI) => void;
declare const _default: (pi: ExtensionAPI) => void;
export default _default;
export declare const __internals: {
    AUTO_ROUTER_SUBCOMMANDS: {
        value: string;
        label: string;
        description?: string;
    }[];
    PROVIDER_ID: string;
    backoffDelay: typeof backoffDelay;
    classifyFailure: typeof classifyFailure;
    cleanErrorMessage: typeof cleanErrorMessage;
    createAutoRouterAutocompleteWrapper: typeof createAutoRouterAutocompleteWrapper;
    createModelAutoRouterExtension: typeof createModelAutoRouterExtension;
    getAvailableTargets: typeof getAvailableTargets;
    getHiddenProviderIds: typeof getHiddenProviderIds;
    getLogPath: typeof getLogPath;
    maxTransientRetries: typeof maxTransientRetries;
    parseSseErrorJson: typeof parseSseErrorJson;
    rankTargets: typeof rankTargets;
    readLogTail: typeof readLogTail;
    resolveConfigValue: typeof resolveConfigValue;
    retryableTransientMessage: typeof retryableTransientMessage;
    routeModelMeta: typeof routeModelMeta;
    runtimeState: Map<string, TargetRuntimeState>;
    stallTimeoutMs: typeof stallTimeoutMs;
    stripJsonc: typeof stripJsonc;
};
