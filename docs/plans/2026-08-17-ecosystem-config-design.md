# dsh-lark-bridge 生态配置 — 设计文档

**Status:** 🕐 待批准
**Date:** 2026-08-17
**Author:** 与用户协作设计
**触发来源:** 用户要求「看看 dsh-plugin 生态，有什么需要的先配置上」

## Goal

把 `@jmoksz/lark-bridge`（v0.6.0）从「功能完整但生态隐形」的状态，配置成**可被发现、可被收录、可被验证**的 dsh 插件：

1. GitHub 元数据补齐（topics + description）→ 进入 `dsh-plugin` 生态搜索
2. 提交 awesome-dsh-plugin 收录 PR → 出现在官方精选列表
3. 加 GitHub Actions CI → 每次提交自动跑测试
4. README 补 badge → 一屏可见版本/收录状态

## 调研发现（现状 vs 生态）

### 本 repo 现状

| 项 | 现状 | 说明 |
|---|---|---|
| npm 发布 | ✅ 0.3.0 → 0.6.0 | `dsh plugin add @jmoksz/lark-bridge` 可装 |
| `dsh.bundle` manifest | ✅ 有 | 可安装性满足 |
| 测试 | ✅ streaming-test + smoke-test | 无需飞书/真实模型 |
| 设计文档 | ✅ docs/plans/ | 符合结构化工作流 |
| **GitHub topics** | ❌ 空 | 无法被 `dsh-plugin` topic 检索到 |
| **GitHub description** | ❌ 空 | repo 列表页无说明 |
| **awesome-dsh-plugin 收录** | ❌ 未收录 | 列表已有 2 个同名 `dsh-lark-bridge`（imetn/shrekcg），本 repo 不在 |
| **CI** | ❌ 无 .github/ | 无自动验证 |
| **README badge** | ❌ 无 | 无 npm 版本/收录标识 |

### 收录条件核对（awesome-dsh-plugin/contributing.md）

| 条件 | 本 repo | 结果 |
|---|---|---|
| `dsh.bundle` manifest（非仅 `dsh.client`） | ✅ 有 | 过 |
| 真实可用代码 | ✅ 1382 行 lib + 测试 | 过 |
| 创建 ≥ 1 天、commits ≥ 10 | ✅ 2026-08-14 创建，12 commits | 过 |
| 仓库加 `dsh-plugin` topic | ❌ 空 | **需先补** |
| 描述属实、无营销词 | 按现有 README 功能描述写 | 待写 |
| 活跃维护 | ✅ 近 3 天持续提交 | 过 |

**结论：唯一硬缺口是 GitHub topics，其余直接可提 PR。**

## 已确认的设计决策

1. **收录走官方流程**：fork `awesome-dsh-plugin` → 新增 `data/plugins/JMOKSZ__dsh-lark-bridge.yml` → 运行其 `scripts/generate-readme.mjs` 重新生成 README → 提交 PR
2. **分类选 `notify`**（Notifications & Integrations）：本 repo 是 IM 入口/桥接，与 amlyczz/dsh-lark-link、omdsh-dev/dsh-lark 同类
3. **CI 只跑现有测试**，不新增测试逻辑：`node test/streaming-test.mjs` + `node test/smoke-test.mjs`（无需飞书凭据）
4. **不改功能代码**：本次纯配置，不碰 lib/、不引入新依赖
5. **GitHub 元数据**：description 用英文一句话 + topics 加 `dsh-plugin`、`feishu`、`lark`、`deepseek-harness`、`dsh`、`bot`、`im-bridge`

## 配置明细

### 1. GitHub 元数据（gh CLI 直接改）

```bash
gh repo edit JMOKSZ/dsh-lark-bridge \
  --description "Feishu (Lark) entry point for DeepSeek Harness: drive dsh agents from a Feishu bot with streaming cards, ask/approval buttons and attachments."
gh repo edit JMOKSZ/dsh-lark-bridge --add-topic dsh-plugin,feishu,lark,deepseek-harness,dsh,im-bridge,bot
```

### 2. awesome-dsh-plugin 收录 PR

新建文件（fork 后）：

```yaml
# data/plugins/JMOKSZ__dsh-lark-bridge.yml
url: https://github.com/JMOKSZ/dsh-lark-bridge
name: JMOKSZ/dsh-lark-bridge
category: notify
description:
  en: 'Feishu (Lark) bridge for DeepSeek Harness: one-command install, streaming progress cards with a tool panel, ask/approval button cards, attachments, and proactive feishu_send pushes.'
  zh: '飞书入口插件：一条命令安装，流式进度卡片带工具面板、提问/审批按钮卡片、附件处理与 feishu_send 主动推送。'
```

然后按官方流程 `npm ci && node scripts/generate-readme.mjs` 重新生成两个 README，随 YAML 一起提交 PR（标题形如 `Add JMOKSZ/dsh-lark-bridge`）。

### 3. GitHub Actions CI（本 repo 新增 `.github/workflows/ci.yml`）

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --no-frozen-lockfile
      - run: node test/streaming-test.mjs
      - run: node test/smoke-test.mjs
```

### 4. README badge（README.md 顶部）

```
[![npm](https://img.shields.io/npm/v/@jmoksz/lark-bridge)](https://www.npmjs.com/package/@jmoksz/lark-bridge)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
```

（收录 PR 合并后才显示第二个 badge；不合并也不阻塞其余配置）

## 执行方式

按 superpowers-stu：任务 < 5 个、相互依赖 → 本会话内逐步执行（不派子代理）：

1. ✅（本设计文档）
2. GitHub 元数据（快，gh CLI）
3. CI 文件 + README badge（本地写文件 + 提交）
4. fork + 收录 PR（gh CLI，最后做，因依赖 topic 已加）

## 风险与回滚

| 风险 | 应对 |
|---|---|
| 收录 PR 被维护者打回（描述不实） | 描述严格对照 README 功能写，不夸大 |
| CI 首次运行失败 | 本地先跑通两个测试再提交 |
| topics/description 改错 | gh CLI 可随时 `--remove-topic` / 重设 description |

## 不做的事（本次范围外）

- 不新增飞书功能（MCP 工具、QR 认证等竞品特性）—— 如需要另开设计
- 不改 lib/ 实现代码
- 不碰 npm 发布（0.6.0 已是最新）
