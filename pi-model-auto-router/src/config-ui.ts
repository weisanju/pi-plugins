import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, Spacer } from "@earendil-works/pi-tui";

// ----- Types (mirror the exported types from index.ts) -----

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

export type RoutesConfig = {
  routes: Record<string, RouteDefinition>;
  hide?: string[];
  show?: string[];
};

type AvailableModel = {
  provider: string;
  id: string;
  name?: string;
  api?: string;
};

// ----- Helpers -----

function selectTheme(theme: any) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

function frame(theme: any, title: string, body: any[], footer?: string): Container {
  const container = new Container();
  container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
  container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
  for (const child of body) container.addChild(child);
  if (footer) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", footer), 1, 0));
  }
  container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
  return container;
}

/** Create a SelectList overlay, returns the selected value or null on cancel */
function selectOne<T extends string>(
  ctx: ExtensionCommandContext,
  title: string,
  items: SelectItem[],
  footer?: string,
): Promise<T | null> {
  return ctx.ui.custom<T | null>((tui, theme, _kb, done) => {
    const list = new SelectList(items, Math.min(items.length, 15), selectTheme(theme));
    list.onSelect = (item) => done(item.value as T);
    list.onCancel = () => done(null);
    const container = frame(theme, title, [new Spacer(1), list], footer ?? "↑↓ 导航  Enter 确认  Esc 返回");
    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => { list.handleInput(data); tui.requestRender(); },
    };
  }, { overlay: true });
}

/** Get available models from the registry */
async function getAvailableModels(ctx: ExtensionCommandContext): Promise<AvailableModel[]> {
  try {
    const registry = (ctx as any).modelRegistry;
    if (typeof registry?.getAvailable === "function") {
      return await registry.getAvailable();
    }
  } catch { /* ignore */ }
  return [];
}

/** Parse a float from string, returns undefined if invalid */
function parseWeight(input: string | null | undefined): number | undefined {
  if (input == null || input.trim() === "") return undefined;
  const val = parseFloat(input.trim());
  if (Number.isNaN(val) || val <= 0) return undefined;
  return val;
}

// ----- Main entry point -----

export async function openRouteConfigUI(
  ctx: ExtensionCommandContext,
  initialConfig: RoutesConfig,
  saveConfig: (config: RoutesConfig) => void,
): Promise<void> {
  let config = structuredClone(initialConfig);
  const availableModels = await getAvailableModels(ctx);

  while (true) {
    const routeCount = Object.keys(config.routes).length;
    const routeEntries = Object.entries(config.routes);

    // Build main menu items
    const mainItems: SelectItem[] = [];

    // Show existing routes — Enter 进入编辑（删除在编辑界面内操作）
    for (const [name, route] of routeEntries) {
      const targetCount = route.targets?.length ?? 0;
      const strategy = route.strategy ?? "least-loaded";
      const targetSummary = route.targets?.map((t) => `${t.provider}/${t.model}`).join(", ") || "(无目标)";
      mainItems.push({
        value: `__edit_${name}`,
        label: `📋 ${name}  [${strategy}]`,
        description: `${targetCount} 个目标: ${targetSummary}`,
      });
    }

    mainItems.push(
      { value: "add", label: "➕ 添加分组", description: "创建新的路由分组" },
    );

    const action = await selectOne<string>(
      ctx,
      "Model Auto Router 配置",
      mainItems,
      `↑↓ 导航  Enter 确认  Esc 退出${routeCount > 0 ? `  ·  ${routeCount} 个分组` : ""}`,
    );

    if (action === null) break;
    if (action.startsWith("__edit_")) {
      const routeName = action.slice(7);
      const updated = await showEditRoute(ctx, routeName, config, availableModels);
      if (updated) {
        config = updated;
        saveConfig(config);
        ctx.ui.notify(`✅ 分组 "${routeName}" 已更新`, "info");
      }
      continue;
    }

    // Add
    if (action === "add") {
      const result = await showAddRoute(ctx, config, availableModels);
      if (result) {
        config = {
          ...config,
          routes: { ...config.routes, [result.name]: result.definition },
        };
        saveConfig(config);
        ctx.ui.notify(`✅ 分组 "${result.name}" 已添加`, "info");
      }
      continue;
    }

}
}

// ----- Add route -----

async function showAddRoute(
  ctx: ExtensionCommandContext,
  config: RoutesConfig,
  availableModels: AvailableModel[],
): Promise<{ name: string; definition: RouteDefinition } | null> {
  // Step 1: Input name
  const name = await ctx.ui.input("请输入分组名称（如 fast-gpt、coding）:");
  if (!name || name.trim().length === 0) return null;
  const trimmedName = name.trim();

  // Check duplicate — 不允许重复
  if (config.routes[trimmedName]) {
    ctx.ui.notify(`分组名称 "${trimmedName}" 已存在，请使用其他名称`, "warning");
    return null;
  }

  // Step 2: Select strategy
  const strategyItems: SelectItem[] = [
    { value: "least-loaded", label: "least-loaded", description: "最少负载优先（默认）— 选择负载最低的目标" },
    { value: "round-robin", label: "round-robin", description: "轮询 — 按顺序轮流使用目标" },
    { value: "cache-first", label: "cache-first", description: "缓存优先 — 优先使用第一个可用目标" },
  ];
  const strategy: RouteDefinition["strategy"] = (await selectOne<string>(ctx, "选择路由策略", strategyItems)) as RouteDefinition["strategy"] ?? "least-loaded";

  // Step 3: Manage targets
  const targets = await manageTargets(ctx, [], availableModels);
  if (targets === null) return null;

  return {
    name: trimmedName,
    definition: {
      targets,
      strategy: strategy as RouteDefinition["strategy"],
    },
  };
}

// ----- Edit route -----

async function showEditRoute(
  ctx: ExtensionCommandContext,
  routeName: string,
  config: RoutesConfig,
  availableModels: AvailableModel[],
): Promise<RoutesConfig | null> {
  const route = config.routes[routeName];
  if (!route) return null;

  let currentName = routeName;
  let currentStrategy = route.strategy ?? "least-loaded";
  let currentTargets = [...(route.targets ?? [])];

  while (true) {
    const targetCount = currentTargets.length;
    const targetSummary = currentTargets.map((t) => `${t.provider}/${t.model} (w=${t.weight ?? 1})`).join(", ") || "(无)";

    const items: SelectItem[] = [
      { value: "name", label: `✏️ 修改名称: ${currentName}`, description: "" },
      { value: "strategy", label: `⚙️ 修改策略: ${currentStrategy}`, description: "" },
      { value: "targets", label: `🎯 管理目标模型 (${targetCount} 个)`, description: targetSummary },
    { value: "delete", label: `🗑️ 删除此分组`, description: "" },
      { value: "back", label: "↩ 返回主菜单", description: "" },
    ];

    const action = await selectOne<string>(ctx, `编辑分组: ${currentName}`, items, "↑↓ 导航  Enter 选择  Esc 返回");

    if (action === null || action === "back") break;

    if (action === "name") {
      const newName = await ctx.ui.input(`修改分组名称（当前: ${currentName}）:`);
      if (newName && newName.trim().length > 0 && newName.trim() !== currentName) {
        const trimmed = newName.trim();
        if (config.routes[trimmed] && trimmed !== routeName) {
          ctx.ui.notify(`名称 "${trimmed}" 已被使用`, "warning");
        } else {
          currentName = trimmed;
          ctx.ui.notify(`名称已改为 "${currentName}"`, "info");
        }
      }
    }

    if (action === "strategy") {
      const strategyItems: SelectItem[] = [
        { value: "least-loaded", label: "least-loaded", description: "最少负载优先" },
        { value: "round-robin", label: "round-robin", description: "轮询" },
        { value: "cache-first", label: "cache-first", description: "缓存优先" },
      ];
      const newStrategy = await selectOne<string>(ctx, "选择策略", strategyItems) as RouteDefinition["strategy"] | null;
      if (newStrategy) {
        currentStrategy = newStrategy;
        ctx.ui.notify(`策略已改为 "${newStrategy}"`, "info");
      }
    }

    if (action === "targets") {
      const updated = await manageTargets(ctx, currentTargets, availableModels);
      if (updated !== null) {
        currentTargets = updated;
      }
    }

    if (action === "delete") {
      const confirmed = await ctx.ui.confirm(
        "确认删除",
        `确定要删除分组 "${currentName}" 吗？\n\n此操作不可撤销。`,
      );
      if (confirmed) {
        const newRoutes = { ...config.routes };
        delete newRoutes[routeName];
        return { ...config, routes: newRoutes };
      }
    }
  }

  // Build new config
  const newRoutes = { ...config.routes };
  delete newRoutes[routeName];
  newRoutes[currentName] = {
    targets: currentTargets,
    strategy: currentStrategy as RouteDefinition["strategy"],
  };

  return { ...config, routes: newRoutes };
}

// ----- Target management (add / remove / edit weight) -----

async function manageTargets(
  ctx: ExtensionCommandContext,
  currentTargets: RouteTarget[],
  availableModels: AvailableModel[],
): Promise<RouteTarget[] | null> {
  let targets = [...currentTargets];

  while (true) {
    const items: SelectItem[] = [];

    // Show current targets
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const key = `${t.provider}/${t.model}`;
      items.push({
        value: `__edit_${i}`,
        label: `  ${key}`,
        description: `权重: ${t.weight ?? 1}${t.maxConcurrency ? `  并发: ${t.maxConcurrency}` : ""}`,
      });
    }

    if (targets.length === 0) {
      items.push({ value: "_empty", label: "  (暂无目标模型)", description: "请添加至少一个目标" });
    }

    items.push(
      { value: "add", label: "➕ 添加目标", description: "从可用模型中选择" },
    );

    if (targets.length > 0) {
      items.push(
        { value: "remove", label: "🗑️ 删除目标", description: "" },
        { value: "weight", label: "⚖️ 修改权重", description: "" },
      );
    }

    items.push({ value: "done", label: "✅ 完成", description: "返回" });

    const action = await selectOne<string>(
      ctx,
      `管理目标模型 (${targets.length} 个)`,
      items,
      "↑↓ 导航  Enter 确认  Esc 返回",
    );

    if (action === null || action === "done") break;

    // Edit target weight via click
    if (action.startsWith("__edit_")) {
      const idx = parseInt(action.slice(7), 10);
      if (idx >= 0 && idx < targets.length) {
        const updated = await editTargetWeight(ctx, targets[idx]);
        if (updated) {
          targets = [...targets];
          targets[idx] = updated;
        }
      }
      continue;
    }

    // Add target
    if (action === "add") {
      const newTarget = await pickModel(ctx, availableModels, targets);
      if (newTarget) {
        targets = [...targets, newTarget];
      }
      continue;
    }

    // Remove target
    if (action === "remove") {
      const removeItems: SelectItem[] = targets.map((t, i) => ({
        value: String(i),
        label: `${t.provider}/${t.model}`,
        description: `权重: ${t.weight ?? 1}`,
      }));
      const idxStr = await selectOne<string>(ctx, "选择要删除的目标", removeItems, "↑↓ 导航  Enter 删除  Esc 返回");
      if (idxStr !== null) {
        const idx = parseInt(idxStr, 10);
        targets = targets.filter((_, i) => i !== idx);
      }
      continue;
    }

    // Edit weight
    if (action === "weight") {
      const weightItems: SelectItem[] = targets.map((t, i) => ({
        value: String(i),
        label: `${t.provider}/${t.model}`,
        description: `当前权重: ${t.weight ?? 1}`,
      }));
      const idxStr = await selectOne<string>(ctx, "选择要修改权重的目标", weightItems, "↑↓ 导航  Enter 选择  Esc 返回");
      if (idxStr !== null) {
        const idx = parseInt(idxStr, 10);
        const updated = await editTargetWeight(ctx, targets[idx]);
        if (updated) {
          targets = [...targets];
          targets[idx] = updated;
        }
      }
      continue;
    }
  }

  return targets;
}

// ----- Edit single target weight -----

async function editTargetWeight(
  ctx: ExtensionCommandContext,
  target: RouteTarget,
): Promise<RouteTarget | null> {
  const key = `${target.provider}/${target.model}`;
  const weightInput = await ctx.ui.input(`设置 "${key}" 的权重 (当前: ${target.weight ?? 1}):`);
  if (weightInput == null) return null;
  const weight = parseWeight(weightInput);
  if (weight === undefined) {
    ctx.ui.notify("权重必须是正数，已取消", "warning");
    return null;
  }
  return { ...target, weight };
}

// ----- Pick a model from available list -----

async function pickModel(
  ctx: ExtensionCommandContext,
  availableModels: AvailableModel[],
  existingTargets: RouteTarget[],
): Promise<RouteTarget | null> {
  if (availableModels.length === 0) {
    ctx.ui.notify("没有可用的模型（请检查 models.json 配置）", "warning");
    return null;
  }

  // Build set of already-added targets to avoid duplicates
  const existingKeys = new Set(existingTargets.map((t) => `${t.provider}/${t.model}`));

  // Step 1: Select provider
  const providerMap = new Map<string, AvailableModel[]>();
  for (const m of availableModels) {
    if (m.provider === "model-auto-router") continue; // skip self
    const list = providerMap.get(m.provider) || [];
    list.push(m);
    providerMap.set(m.provider, list);
  }

  const providerItems: SelectItem[] = [...providerMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, models]) => ({
      value: provider,
      label: provider,
      description: `${models.length} 个模型`,
    }));

  const selectedProvider = await selectOne<string>(ctx, "选择提供者", providerItems, "↑↓ 导航  Enter 选择  Esc 返回");
  if (!selectedProvider) return null;

  // Step 2: Select model from that provider
  const providerModels = providerMap.get(selectedProvider) || [];
  const modelItems: SelectItem[] = providerModels
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => {
      const key = `${m.provider}/${m.id}`;
      const alreadyAdded = existingKeys.has(key);
      return {
        value: m.id,
        label: alreadyAdded ? `${m.id} (已添加)` : m.id,
        description: alreadyAdded ? "已在目标列表中" : (m.name ?? ""),
      };
    });

  const selectedModel = await selectOne<string>(ctx, `选择模型 (${selectedProvider})`, modelItems, "↑↓ 导航  Enter 选择  Esc 返回");
  if (!selectedModel) return null;

  // Step 3: Set weight (optional, default 1)
  const weightInput = await ctx.ui.input(`设置权重 (默认 1):`);
  const weight = weightInput == null ? undefined : (parseWeight(weightInput) ?? 1);
  const finalWeight = weightInput == null || weightInput.trim() === "" ? 1 : (weight ?? 1);

  return {
    provider: selectedProvider,
    model: selectedModel,
    weight: finalWeight,
  };
}