import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
export type RouteTarget = {
    provider: string;
    model: string;
    weight?: number;
    maxConcurrency?: number;
};
export type RouteDefinition = {
    targets: RouteTarget[];
    strategy?: "cache-first" | "least-loaded" | "round-robin";
};
export type RetryConfig = {
    maxRetries?: number;
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    transientCooldownMs?: number;
    longCooldownMs?: number;
};
export type RoutesConfig = {
    routes: Record<string, RouteDefinition>;
    hide?: string[];
    show?: string[];
    retry?: RetryConfig;
};
export declare function openRouteConfigUI(ctx: ExtensionCommandContext, initialConfig: RoutesConfig, saveConfig: (config: RoutesConfig) => void): Promise<void>;
