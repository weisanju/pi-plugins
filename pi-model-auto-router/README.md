# pi-model-auto-router

Pi 扩展：将虚拟路由模型注册为 `model-auto-router` provider，把请求按策略分发到真实 provider/model 目标，内置**负载均衡、故障切换（failover）、重试退避、冷却**机制。

## 安装

```bash
bun add -g pi-model-auto-router   # 或按 Pi 插件方式安装到 ~/.pi/agent
```

需要 `@earendil-works/pi-ai >= 0.84.0`、`@earendil-works/pi-coding-agent >= 0.84.0`。

## 配置

配置文件（按优先级查找第一个存在的）：

| 路径 | 说明 |
|---|---|
| `.pi/model-auto-router.routes.json` | 项目级配置 |
| `~/.pi/agent/extensions/model-auto-router.routes.json` | 全局配置 |

支持 JSONC（注释 + 尾逗号）。修改后执行 `/auto-router reload` 生效，或直接使用 TUI `/auto-router config` 可视化编辑（保存即生效）。

### 完整字段说明

```jsonc
{
  // ═══ 重试与冷却（可选，缺省用默认值；也可在 TUI 的 "⚙️ 重试与冷却设置" 中配置）═══
  "retry": {
    "maxRetries": 4,              // 所有目标瞬态失败后的整轮重试次数，0 = 禁用重试（默认 3）
    "backoffBaseMs": 2000,        // 退避起始间隔 ms，每轮翻倍（默认 2000）
    "backoffMaxMs": 30000,        // 退避等待上限 ms（默认 30000）
    "transientCooldownMs": 60000, // 瞬态失败（限流/超时/网络）冷却 ms（默认 60000 = 1m）
    "longCooldownMs": 43200000    // quota/config 类失败冷却 ms（默认 43200000 = 12h）
  },

  // ═══ 路由分组 ═══
  "routes": {
    "default": {                   // 路由 id 即模型 id，在 provider model-auto-router 下选择
      "strategy": "least-loaded",  // least-loaded(默认) | round-robin | cache-first
      "targets": [
        {
          "provider": "ducky",    // 对应 ~/.pi/agent/models.json 中的 provider id
          "model": "qwen3.8-max", // 模型 id
          "weight": 2,            // 负载均衡权重（least-loaded 按 active/weight 计分，默认 1）
          "maxConcurrency": 3,    // 该目标最大并发，超过则跳过（可选）
          "api": "openai-completions",        // 覆盖 api（可选）
          "baseUrl": "https://...",           // 覆盖 baseUrl（可选）
          "contextWindow": 200000,            // 覆盖窗口（可选，路由取各目标最小值）
          "maxTokens": 8192,                  // 覆盖 maxTokens（可选）
          "compat": { "supportsDeveloperRole": false } // 追加 compat（可选）
        }
      ]
    }
  },

  // ═══ 隐藏 provider（可选）═══
  // 下列 provider 会被注册为空模型来"隐藏"，避免 Pi 直接列出目标 provider。
  // 路由里出现的 provider 会自动隐藏；show 可豁免 hide。
  "hide": ["anthropic"],
  "show": []
}
```

### 优先级

- **重试**：`routes.json retry.*` > 环境变量 `MODEL_AUTO_ROUTER_MAX_RETRIES` > 内置默认
- **API Key**：`<PROVIDER>_AUTH_TOKEN` / `<PROVIDER>_API_KEY` 环境变量 > models.json 中 provider 的 `apiKey`（支持 `${ENV_VAR}` 展开）
- **baseUrl**：目标 `baseUrl` > models.json provider.`baseUrl` > `<PROVIDER>_BASE_URL` env > provider id

### 支持的环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MODEL_AUTO_ROUTER_MAX_RETRIES` | `3` | 最大重试轮数（被 routes.json `retry.maxRetries` 覆盖） |
| `MODEL_AUTO_ROUTER_STALL_TIMEOUT_MS` | `90000` | 目标流超过该时长无任何事件判定为挂起，强制终止（90s） |
| `MODEL_AUTO_ROUTER_STALL_CHECK_MS` | `5000` | 挂起检查的间隔（测试可调小） |
| `MODEL_AUTO_ROUTER_LOG` | 开 | 设为 `off` 关闭日志 |
| `MODEL_AUTO_ROUTER_LOG_PATH` | `~/.pi/agent/model-auto-router.log` | 日志文件路径 |

> **注意**：重试完全由 auto-router 统一控制（`retry.maxRetries` + 退避）。透传给底层 provider 时已剥离 `maxRetries`/`maxRetryDelayMs`，避免 pi-ai 的 provider 层（OpenAI/Anthropic SDK 风格，指数退避 0.5s→8s 封顶）在路由重试之上再叠加一层不可见的重试。

## TUI 配置

运行 `/auto-router config` 打开可视化配置：

- **+ 添加分组**：输入名字 → 选策略 → 添加目标模型（从注册表挑选 provider/model，可设权重）
- **编辑分组**：改名称 / 改策略 / 管理目标（增删、改权重）/ 删除分组
- **⚙️ 重试与冷却设置**：最大重试轮数、退避起始间隔、退避上限、瞬态失败冷却、严重失败冷却
  - 时长输入支持 `5` / `30s` / `2m` / `1h`，留空恢复默认，可一键全部恢复默认

## 命令

| 命令 | 说明 |
|---|---|
| `/auto-router status` | 查看路由、目标负载、冷却、失败统计 |
| `/auto-router log [N]` | 最近 N 条路由/切换/重试事件（默认 20） |
| `/auto-router reset` | 清空冷却和运行时计数 |
| `/auto-router reload` | 重新加载 routes 与隐藏 provider |
| `/auto-router config` | 打开 TUI 配置 |
| `/auto-router debug` | 列出注册表可用模型 |

## 路由策略

- **least-loaded**（默认）：按 `active/weight + failures*0.05` 计分选最低，兼顾当前并发与历史失败
- **round-robin**：按累计被选次数轮询
- **cache-first**：固定优先第一个可用目标，失败才切换

状态行会实时显示：`api-wait` → `streaming` → `retry pass=x/y` / `last=served failovers=n`。

## 失败分类与重试机制

错误按类型处理：

| 分类 | 判定（关键字） | 行为 |
|---|---|---|
| `transient` | 429、rate limit、timeout、502/503/504、overloaded、网络错误等 | failover 到下一目标；全部失败后整轮退避重试（2s 起指数翻倍，上限 30s，可配）；结束后目标冷却 1m（可配） |
| `quota` | 402、insufficient balance、credits exhausted 等 | failover；目标冷却 12h（可配） |
| `config` | model not found、404、401/403、invalid key 等 | failover；目标冷却 12h |
| `fatal` | 其他未知错误 | 立即终止，不再重试 |

流式输出中途（已提交内容后）出现瞬态错误时，只能原样透传错误给前端，无法回滚已输出的内容。

目标流长时间无事件（默认 90s，`MODEL_AUTO_ROUTER_STALL_TIMEOUT_MS` 可调）或用户中止（Esc）时，即使底层流卡死，也会立即清理 streaming 状态、下发错误并结束请求，不会一直停留在 streaming。

## 开发

```bash
bun run build    # tsc 编译到 dist/
bun test         # 运行 e2e 测试（含重试配置覆盖测试）
```