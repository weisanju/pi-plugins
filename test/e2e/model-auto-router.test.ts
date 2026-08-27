import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";

const root = mkdtempSync(join(tmpdir(), "pi-model-auto-router-"));
process.env.HOME = root;
process.env.MODEL_AUTO_ROUTER_LOG = "off";
process.env.MODEL_AUTO_ROUTER_MAX_RETRIES = "0";
process.chdir(root);
mkdirSync(join(root, ".pi"), { recursive: true });
mkdirSync(join(root, ".pi", "agent"), { recursive: true });

writeFileSync(join(root, ".pi", "model-auto-router.routes.json"), JSON.stringify({
  routes: {
    basic: {
      targets: [
        { provider: "test", model: "alpha", contextWindow: 1000, maxTokens: 100 },
        { provider: "test", model: "beta", contextWindow: 2000, maxTokens: 200 },
      ],
    },
    least: {
      targets: [
        { provider: "load", model: "busy" },
        { provider: "load", model: "idle" },
      ],
    },
    failover: {
      targets: [
        { provider: "fail", model: "bad" },
        { provider: "fail", model: "good" },
      ],
    },
  },
  hide: ["anthropic"],
}, null, 2));

writeFileSync(join(root, ".pi", "agent", "models.json"), JSON.stringify({
  providers: {
    test: { baseUrl: "https://test.invalid", api: "openai-completions", models: [{ id: "alpha", name: "alpha", contextWindow: 1000, maxTokens: 100 }, { id: "beta", name: "beta", contextWindow: 2000, maxTokens: 200 }] },
    load: { baseUrl: "https://load.invalid", api: "openai-completions", models: [{ id: "busy", name: "busy" }, { id: "idle", name: "idle" }] },
    fail: { baseUrl: "https://fail.invalid", api: "openai-completions", models: [{ id: "bad", name: "bad" }, { id: "good", name: "good" }] },
  },
}, null, 2));

const { createModelAutoRouterExtension } = await import("../../src/index.ts");

type ProviderConfig = {
  models?: Array<{ id: string; name: string; contextWindow: number; maxTokens: number }>;
  streamSimple?: (model: Model<Api>, context: Context, options?: unknown) => AssistantMessageEventStream;
};

function zeroUsage(): AssistantMessage["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function message(model: Model<Api>, content: AssistantMessage["content"] = []): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: zeroUsage(), stopReason: "stop", timestamp: Date.now() };
}

function successStream(model: Model<Api>, text = "ok"): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const partial = message(model);
    stream.push({ type: "start", partial });
    stream.push({ type: "text_start", contentIndex: 0, partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
    stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
    stream.push({ type: "done", reason: "stop", message: message(model, [{ type: "text", text }]) });
  });
  return stream;
}

function errorStream(model: Model<Api>, errorMessage: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message(model) });
    stream.push({ type: "error", reason: "error", error: { ...message(model), stopReason: "error", errorMessage } });
  });
  return stream;
}

function deferredDoneStream(model: Model<Api>): { stream: AssistantMessageEventStream; finish: () => void } {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => stream.push({ type: "start", partial: message(model) }));
  return {
    stream,
    finish: () => stream.push({ type: "done", reason: "stop", message: message(model) }),
  };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function createPi(streamSimple: (model: Model<Api>, context: Context, options?: unknown) => AssistantMessageEventStream) {
  const providers = new Map<string, ProviderConfig>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }>();
  const handlers = new Map<string, Function[]>();
  const notifications: string[] = [];
  const status = new Map<string, string | undefined>();
  const pi = {
    registerProvider(name: string, config: ProviderConfig) { providers.set(name, config); },
    unregisterProvider(name: string) { providers.delete(name); },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> | void }) { commands.set(name, command); },
    on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
  };
  createModelAutoRouterExtension({ streamSimple })(pi as any);
  const ctx = {
    model: { provider: "model-auto-router", id: "basic" },
    ui: {
      notify(message: string) { notifications.push(message); },
      setStatus(key: string, value: string | undefined) { status.set(key, value); },
      addAutocompleteProvider() {},
    },
    modelRegistry: { getAvailable: async () => [] },
  };
  return { providers, commands, handlers, notifications, status, ctx };
}

describe("pi-model-auto-router e2e", () => {
  it("registers virtual route models and hides target providers", () => {
    const app = createPi((model) => successStream(model));

    expect(app.providers.get("model-auto-router")?.models?.map((model) => model.id).sort()).toEqual(["basic", "failover", "least"]);
    expect(app.providers.get("test")?.models).toEqual([]);
    expect(app.providers.get("load")?.models).toEqual([]);
    expect(app.providers.get("fail")?.models).toEqual([]);
    expect(app.providers.get("anthropic")?.models).toEqual([]);
    expect(app.providers.get("model-auto-router")?.models?.find((model) => model.id === "basic")?.contextWindow).toBe(1000);
  });

  it("routes concurrent requests to the least-loaded target", async () => {
    let held: ReturnType<typeof deferredDoneStream> | undefined;
    const calls: string[] = [];
    const app = createPi((model) => {
      calls.push(`${model.provider}/${model.id}`);
      if (model.id === "busy" && !held) {
        held = deferredDoneStream(model);
        return held.stream;
      }
      return successStream(model, model.id);
    });

    const provider = app.providers.get("model-auto-router")!;
    const routeModel = provider.models!.find((model) => model.id === "least") as Model<Api>;
    const first = collect(provider.streamSimple!(routeModel, { messages: [] }));
    await Bun.sleep(0);
    const secondEvents = await collect(provider.streamSimple!(routeModel, { messages: [] }));
    held!.finish();
    await first;

    expect(calls[0]).toBe("load/busy");
    expect(calls[1]).toBe("load/idle");
    expect(secondEvents.find((event) => event.type === "done" && event.message.model === "idle")).toBeTruthy();
  });

  it("fails over from a pre-content transient failure to the next target", async () => {
    const calls: string[] = [];
    const app = createPi((model) => {
      calls.push(`${model.provider}/${model.id}`);
      if (model.id === "bad") return errorStream(model, "429 rate limit");
      return successStream(model, "served by good");
    });

    const provider = app.providers.get("model-auto-router")!;
    const routeModel = provider.models!.find((model) => model.id === "failover") as Model<Api>;
    const events = await collect(provider.streamSimple!(routeModel, { messages: [] }));

    expect(calls).toEqual(["fail/bad", "fail/good"]);
    expect(events.find((event) => event.type === "done" && event.message.model === "good")).toBeTruthy();
  });

  it("exposes status and reset commands", async () => {
    const app = createPi((model) => successStream(model));
    await app.commands.get("auto-router")!.handler("status", app.ctx);
    await app.commands.get("router")!.handler("reset", app.ctx);

    expect(app.notifications[0]).toContain("Model Auto Router Routes");
    expect(app.notifications[1]).toContain("cooldowns and runtime counters cleared");
  });
});
