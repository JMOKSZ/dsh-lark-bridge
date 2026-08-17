# 飞书智能体式卡片化交互 — 设计文档

**Status:** ✅ Approved（2025-08-17）
**Date:** 2025-08-17
**Author:** 与用户协作设计

## Goal

把 Studio_DSH 飞书机器人（`dsh-lark-bridge` v3.1，App `cli_aa083f62187adbdb`）升级为「飞书智能体」式体验：用户与 DSH 的对话**全程卡片化** —— 每条任务发一张流式回复卡片（思考/工具调用/回答草稿实时 PATCH 更新），工具调用以折叠面板可视化，最终回复入卡（sealed），提问/审批沿用按钮卡片，并新增 agent 主动推送能力（`feishu_send` 工具）。

## 已确认的设计决策

1. **卡片化完整度**：流式卡片 + 工具调用面板 + 最终回复入卡（非仅结果卡片）
2. **主动推送**：新增 `feishu_send` 工具，agent 可主动向当前会话/指定 chat 推送文本或卡片
3. **配置组织**：全部合并进现有 `cardMode` 开关（默认开启），纯文本回复保留为兜底
4. **实现基准**：在现有 `dsh-lark-bridge` 仓库上扩展，不重写、不引入第三方桥接

## Architecture

### 数据流（卡片化后）

```
用户发消息
   │  im.message.receive_v1 (长连接)
   ▼
Bridge.handleIncoming
   │  命中文本/附件 → enqueue
   ▼
runTurn (改造)
   │  cardMode=true
   ├─▶ TurnReporter.begin() → 发送「🤖 DSH 处理中…」卡片 (im.message.create, msg_type=interactive)
   │       │  agent.followup(user message)
   │       ▼
   │  轮询 agent.session.events（300ms 间隔 + turn/end 前补扫）
   │      turn/start      → 状态行「🧠 开始处理…」
   │      step/start      → 状态行「🔄 第 N 步 · 思考中…」
   │      assistant/chunk → reasoning-delta → 思考区；text-delta → 回答草稿区；tool-call-delta → 工具行
   │      tool/call       → 工具面板新增条目「🔧 tool(args)」
   │      tool/result     → 工具面板条目打 ✅/❌ + 摘要
   │      assistant/message → 更新回答区（最终文本）
   │      节流：patchIntervalMs(默认700ms) 合并 → PATCH 卡片 (im.message.patch)
   ▼
TurnReporter.finish(outcome)
   │  停止流式；最终回复入卡（sealed 态：状态行移除、面板保持折叠、含用时/字数）
   ▼
（若卡片链路任一步失败 → 回退纯文本回复，与 v3.1 行为一致）
```

### 组件

| 组件 | 文件 | 职责 |
|---|---|---|
| `TurnReporter` | `lib/streaming.js`（新） | 流式卡片生命周期：begin/onEvent/finish；事件→卡片状态；节流 PATCH 调度；纯函数卡片构建放 cards.js 以便单测 |
| 卡片构建扩展 | `lib/cards.js`（扩展） | `streamingCard(state)` 构建流式卡片 JSON；`toolPanel(state)` 工具折叠面板；sealed 态 |
| `feishu_send` 工具 | `lib/push.js`（新） | agent 工具：向当前会话或指定 chat 推送文本/卡片；返回推送结果 |
| Bridge 集成 | `lib/index.js`（改造） | `runTurn` 接入 TurnReporter；事件轮询注入；`cardMode` 默认 true；transport 增加 `sendCard`/`patchCard` 复用 |
| 配置 schema | `lib/index.js` | `cardMode` 默认 `true`；新增 `streaming` 子配置 |

### 新增配置项（都在 `cordis.patch.yml` 的 `lark-bridge` 行下）

```yaml
- id: lark-bridge
  config:
    cardMode: true                    # 默认改为 true
    streaming:
      patchIntervalMs: 700            # PATCH 节流间隔（飞书限流）
      maxBodyChars: 900               # 卡片正文截断（卡片体积限制）
      showReasoning: true             # 是否展示思考区
      showToolCalls: true             # 是否展示工具面板
      cardTitleStreaming: "🤖 DSH 处理中…"
      cardTitleDone: "🤖 DSH 处理完成"
    push:                             # feishu_send 工具
      enabled: true
      defaultChatId: ""               # 缺省推送目标（空 = 当前会话）
```

### 事件轮询机制

- 复用现有 `agent.session.events` 事件数组（`runTurn` 已在用 `summarize` 遍历它）
- 轮询间隔 300ms；`turn/end` 出现后停止轮询并补扫一次（快回合不丢中间过程）
- 事件消费用游标（`event.seq`），避免重复处理

## Interface / API

### feishu_send 工具（agent 视角）

```
工具名: feishu_send
参数:
  chatId?: string   # 目标 chat_id；缺省 = 当前会话所在 chat
  text?: string     # 要推送的文本
  card?: object     # 可选的完整卡片 JSON（进阶用法）
  title?: string    # cardMode 下自动包装卡片时用的标题（可选）
返回: { ok: true, message_id } | { ok: false, error }
```

- 单聊/群聊均可；agent 用于「任务中途汇报」「结果分发给指定群」「需要用户注意时主动提醒」
- 该工具在 `agentPreset` 装配时注册（沿用 `standard` preset 挂载机制，参考 CHANNEL_INSTRUCTIONS 的注入方式）

### 卡片 JSON 结构（流式）

```jsonc
{
  "config": { "wide_screen_mode": true, "streaming_mode": true },
  "header": { "template": "blue", "title": { "tag": "plain_text", "content": "🤖 DSH 处理中…" } },
  "elements": [
    { "tag": "div", "text": { "tag": "lark_md", "content": "**状态：** 🧠 正在思考…" } },
    { "tag": "hr" },
    { "tag": "div", "text": { "tag": "lark_md", "content": "**思考：** 用户想分析测试覆盖率…" } },   // showReasoning
    { "tag": "div", "text": { "tag": "lark_md", "content": "**回答草稿：** …" } },                    // 有内容才显示
    { "tag": "div", "text": { "tag": "lark_md", "content": "**工具调用：**" } },
    { "tag": "div", "text": { "tag": "lark_md", "content": "🛠️ <b>bash</b> · `ls -la`\n✅ <b>read_image</b> · 完成" } }, // 折叠面板，showToolCalls
    { "tag": "note", "elements": [{ "tag": "plain_text", "content": "正在实时更新…" }] }
  ]
}
```

sealed 态：header 变绿「🤖 DSH 处理完成」，状态行移除，工具面板保留折叠，回答区显示最终回复，note 显示「✅ 完成 · 用时 Xs · 输出 N 字」。

## Error Handling

| 失败点 | 处理 |
|---|---|
| 流式卡片 `create` 失败 | 回退纯文本回复（现有 v3.1 行为），不再重试卡片 |
| 卡片 `patch` 失败 | 指数退避重试（3 次）；仍失败则标记 reporter 降级，最终用纯文本补发回答 |
| 轮询期间 turn 出错（`turn/end` reason=error） | 卡片 sealed 为错误态（header 红「😵 DSH 处理失败」+ 错误信息）；同时保留文本兜底 |
| 连续 PATCH 失败（熔断） | 5 次失败后停 PATCH，转纯文本模式（借鉴 feishucard 的熔断思路） |
| PATCH 限流 | 节流合并（patchIntervalMs）+ 串行更新队列，单飞书应用卡片 PATCH 有频控 |
| `feishu_send` 目标 chat 不可达 | 返回 `{ ok:false, error }`，agent 可自行处理（如换默认会话） |
| 交互等待期间有卡片流式进行中 | 互不干扰：流式卡片只属于 runTurn；提问/审批卡片仍走 interactions 流程 |

## Testing Strategy

1. **单元测试（新增 `test/streaming-test.mjs`）**：纯函数级
   - `streamingCard` 构建：各状态（begin/思考/工具调用/草稿/sealed/错误）的卡片 JSON 字段断言
   - `toolPanel`：工具条目 ✅/❌ 与摘要渲染
   - 事件序列驱动：喂入 turn/start → step/start → assistant/chunk(reasoning) → tool/call → tool/result → assistant/message → turn/end，断言状态迁移
   - 节流合并：patchIntervalMs 内多次 onEvent 只触发一次调度
2. **端到端冒烟（扩展 `test/smoke-test.mjs`，mock 传输 + mock LLM 流式输出）**：
   - mock LLM 服务器改为流式输出（chunk 事件），验证：收到消息 → 出现 `kind:"card"` 流式卡片 → 若干 `kind:"patch"` → 最终 sealed patch 含最终回复
   - 工具调用事件 → 卡片含工具面板条目
   - 卡片 create 失败场景 → 回退文本 reply
   - `feishu_send`：mock 对话中 agent 调用工具 → mock outgoing 出现 push 记录
3. **回归**：现有 25 个 smoke checks 全部保持通过
4. **手工验收**（可选）：真实 App 上跑一次长任务，观察飞书端卡片实时更新

## Open Questions（已定）

- **ack「⏳ 收到」**：卡片化后即时反馈，`ackEnabled` 默认改为 `false`（保留开关兼容旧行为）
- **思考区（reasoning）**：默认展示尾部摘要（`showReasoning: true`），受 `maxBodyChars` 截断
- **`feishu_send` 卡片透传**：宽松透传 + 发送失败返回 `{ ok:false, error }`
