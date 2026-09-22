# pi-plugs 开发说明（供 Agent 阅读）

该仓库按插件名分目录组织，每个插件独立 `package.json`、独立发布到 npm。

## 目录结构

- `pi-model-auto-router/`：模型自动路由插件（源码 `src/`、构建产物 `dist/`（入库）、测试 `test/`）

## 开发（pi-model-auto-router）

```bash
cd pi-model-auto-router
bun install        # 安装依赖
bun run check      # tsc 类型检查（--noEmit）
bun test           # 全量测试（unit + e2e）
bun run build      # 构建到 dist/（dist 入库，需随源码一起提交）
```

- 修改源码后必须同步重建 `dist/` 并一起提交
- 提交信息格式：`pi-model-auto-router: x.y.z — 中文描述`（一行主题 + 正文说明根因/修复/测试）
- 版本号在 `package.json` 中维护，发布流程见下

## 发版流程（tag 触发 CI 自动发布）

推送版本 tag 即触发 `.github/workflows/release.yml` 自动执行完整发布流水线：

```bash
# 1. 确认改动已合入 main，且 package.json 版本号已更新
# 2. 打 tag 并推送（两种历史格式均可，新 tag 建议用斜杠式）：
git tag pi-model-auto-router/v0.4.0
git push origin pi-model-auto-router/v0.4.0
```

流水线步骤：tag 格式与 `package.json` 版本一致性校验 → 类型检查 + 测试（质量门禁，失败不发布）→ 构建 → `npm publish --provenance` → 自动创建 GitHub Release（自动生成变更说明）。

注意：

- tag 版本号必须与 `package.json` 的 `version` 完全一致，否则 CI 直接失败
- npm 发布依赖仓库 secret `NPM_TOKEN`
- 历史上存在两种 tag 命名（`pi-model-auto-router/vX.Y.Z` 斜杠式与 `pi-model-auto-router-vX.Y.Z` 连字符式），CI 两者兼容；新版本统一使用斜杠式
- 不要手动运行 `npm publish`，一律走 tag 触发的 CI
