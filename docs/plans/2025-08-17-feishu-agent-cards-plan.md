# 飞书智能体式卡片化交互 — 实现计划

**Status:** 待执行（Plan）
**Date:** 2025-08-17
**Design:** [2025-08-17-feishu-agent-cards-design.md](./2025-08-17-feishu-agent-cards-design.md)（✅ Approved）

## 执行方式

任务高度耦合（同一批文件的改造 + TDD 循环），使用 **plan-executor** 在本会话逐任务执行。

## 任务列表

### Task 1: 流式卡片纯函数构建（lib/cards.js 扩展）

**文件**: `lib/cards.js`
**内容**: 新增 `streamingCard(state)`、`toolPanelEntry(tool)`、`sealedCard(state)` 纯函数：
- `streamingCard(state)`：根据 `{ status, reasoning, answer, tools: [{name, args, status, summary}], titleStreaming, showReasoning, showToolCalls }` 构建流式卡片 JSON（含 `streaming_mode`、状态行、思考区、回答草稿区、工具面板、note）
- 工具面板：每工具一行 `🛠️/✅/❌ <b>name</b> · args摘要`，lark_md 渲染
- 所有正文按 `maxBodyChars` 截断（复用 truncate 思路，放 cards.js 内私有函数）
- 不 import DSH 任何东西（保持现有纯函数约定）

**TDD**:
- RED: `test/streaming-test.mjs` 先写 `streamingCard` 各状态断言
- GREEN: 实现 cards.js 扩展
- 验证: `node test/streaming-test.mjs`

### Task 2: TurnReporter 流式生命周期（lib/streaming.js 新建）

**文件**: `lib/streaming.js`（新）
**内容**: `TurnReporter` 类：
- `constructor({ config, sendCard, patchCard, logger })`
- `begin({ replyToMessageId })` → 发送初始卡片，存 cardMessageId
- `onEvent(event)` → 事件驱动状态更新（turn/start, step/start, assistant/chunk[text-delta/reasoning-delta/tool-call-delta], tool/call, tool/result, assistant/message），节流调度 PATCH
- `finish(outcome)` → sealed 态最终 PATCH（绿/红头、用时、字数）
- 节流：`patchIntervalMs` 合并 + 串行队列；PATCH 失败指数退避 3 次；连续 5 次熔断置 degraded
- `dispose()` 清理定时器

**TDD**:
- RED: `test/streaming-test.mjs` 写事件序列→状态迁移断言（含节流合并、熔断）
- GREEN: 实现 streaming.js（用 fake transport 注入）
- 验证: `node test/streaming-test.mjs`

### Task 3: feishu_send 推送工具（lib/push.js 新建）

**文件**: `lib/push.js`（新）
**内容**:
- `createPushTool({ ctx, transport, getChatForAgent })` 返回工具定义：
  - 参数 schema：`chatId?`、`text?`、`card?`、`title?`
  - 缺省 chatId = 当前 agent 所在 chat（经 getChatForAgent）
  - `text` 时发文本消息（transport.create）；`card` 时发卡片（transport.sendCard）
  - 返回 `{ ok, message_id }` 或 `{ ok:false, error }`

**TDD**:
- RED: `test/streaming-test.mjs` 写工具调用断言（mock transport 记录）
- GREEN: 实现 push.js
- 验证: `node test/streaming-test.mjs`

### Task 4: Bridge 集成（lib/index.js 改造）

**文件**: `lib/index.js`
**内容**:
- Config：`cardMode` 默认 `true`；`ackEnabled` 默认 `false`；新增 `streaming` 子对象（patchIntervalMs=700, maxBodyChars=900, showReasoning=true, showToolCalls=true, cardTitleStreaming, cardTitleDone）；`push` 子对象（enabled=true, defaultChatId=""）
- transport 已有 `sendCard`/`patchCard`，MockTransport 已实现（复用）
- `runTurn`：cardMode 时创建 TurnReporter，begin → agent.followup → 轮询 session.events（300ms + turn/end 补扫）→ finish；reporter 降级或失败时回退纯文本 reply
- 轮询游标：用 `event.seq`（复用 summarize 的 firstSeq 思路）
- `feishu_send` 工具注册：在 `ensureChatAgent` 的 setup 钩子里注册（agentCtx.tool 或等价机制——按 dsh-agent 的注册方式），需要调研 agent 工具注册 API
- 交互（提问/审批）逻辑不动；流式卡片与 interactions 互不干扰

**TDD**:
- RED: 扩展 `test/smoke-test.mjs`：mock LLM 流式输出 → 断言 card→patch→sealed 序列、工具面板、失败兜底、feishu_send
- GREEN: 实现集成
- 验证: `node test/smoke-test.mjs`（全量回归 25+ 新 checks）

### Task 5: mock LLM 流式输出（test/mock-llm-server.mjs 扩展）

**文件**: `test/mock-llm-server.mjs`
**内容**: mock 模型路由支持流式 SSE（assistant/chunk 事件序列：reasoning-delta → tool-call → tool/result → text-delta → 结束），并支持一个触发工具调用的测试输入（如 `请用 bash 查看文件` 触发 mock 工具，再调 feishu_send）
**验证**: smoke 测试中流式场景通过

### Task 6: 文档与版本（README + package.json）

**文件**: `README.md`、`package.json`
**内容**:
- README：功能特性更新（流式卡片、工具面板、feishu_send）、配置表更新（cardMode 默认 true、streaming/push 配置）、已知限制更新
- package.json：版本号 bump 到 0.6.0
**验证**: 无（文档审查）

## 提交策略

- 每个 Task GREEN 后单独 commit：`test: ...` / `feat: ...` / `docs: ...`
- 最终提交包含全部

## 验证总览

```bash
node test/streaming-test.mjs    # 单元测试（Task 1-3）
node test/smoke-test.mjs        # 端到端冒烟（Task 4-5，回归 25 checks）
```
