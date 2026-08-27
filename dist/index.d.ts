import { createAssistantMessageEventStream, type Api } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
type RouteTarget = {
    provider: string;
    model: string;
    weight?: number;
    maxConcurrency?: number;
    api?: Api;
    baseUrl?: string;
    contextWindow?: number;
    maxTokens?: number;
};
type RouteDefinition = {
    targets: RouteTarget[];
    strategy?: "least-loaded" | "round-robin";
    contextWindow?: number;
    maxTokens?: number;
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
declare function backoffDelay(attempt: number): number;
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
    stripJsonc: typeof stripJsonc;
};
