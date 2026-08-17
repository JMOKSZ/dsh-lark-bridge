# DSH 飞书入口（Lark Bridge）

[![npm](https://img.shields.io/npm/v/@jmoksz/lark-bridge)](https://www.npmjs.com/package/@jmoksz/lark-bridge)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
[![CI](https://github.com/JMOKSZ/dsh-lark-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/JMOKSZ/dsh-lark-bridge/actions)

通过**飞书机器人**远程使用 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness)：在飞书里给机器人发消息，机器人交给运行在本机的 DSH agent 执行（读写文件、跑命令、搜索网页等），处理过程用**流式消息卡片**实时呈现，最终回答 sealed 进卡片回复。

本质是一个 cordis 插件（`@jmoksz/lark-bridge`）+ 一个 DSH profile（`lark`）。走官方**长连接**（WebSocket），无需公网 IP、无需反向代理，在家/内网即可部署。

## 功能与特点

- 🎞️ **流式回复卡片（默认开启）**：每条任务一张「🤖 DSH 处理中…」实时卡片，思考、回答草稿、**工具调用面板**（状态符号·工具名·参数摘要）随执行 PATCH 更新；完成 sealed 为绿色终态（最终回复+用时+字数），出错为红色错误态
- 📨 **主动推送**：agent 可用 `feishu_send` 工具主动向会话推送文本/卡片（中途汇报、结果分发、主动提醒）
- 🎴 **交互问答 & 审批卡片**：`ask_user_question` 与工具审批渲染为按钮卡片，点击即作答；也可直接回复编号/文字
- 🖼️ **附件处理**：图片/文件/视频/音频自动下载保存；视觉模型下图片直接附加给模型
- 📝 **富文本**：`post` 富文本消息自动提取纯文本
- 🧵 **多会话**：每个飞书 chat（单聊或群）一个独立 DSH session，互不干扰；跨重启自动恢复上下文
- 👥 **群聊 @ 过滤**：默认只在被 @ 时响应（可关闭）
- 🛠 **命令**：`/new`（新会话）、`/status`、`/whoami`、`/help`

## 安装

前置：本机已装 **DSH CLI**（`npm i -g @deepseek-ai/dsh`）、**pnpm**、Node.js ≥ 22，以及一个可用的 LLM key。

一条命令安装（自动创建 `lark` profile，无需额外补丁文件）：

```bash
# 从 npm 安装
dsh plugin --profile lark add @jmoksz/lark-bridge --ignore-scripts

# 或从 GitHub 安装
dsh plugin --profile lark add github:JMOKSZ/dsh-lark-bridge --ignore-scripts
```

本地开发：clone 后运行 `./scripts/setup-lark-profile.sh`（可重复执行刷新代码）。

## 配置

### 1. 飞书开放平台（一次性）

1. 创建**企业自建应用**，添加**机器人**能力，记下 **App ID** / **App Secret**
2. 开通权限：`im:message`、`im:message:send_as_bot`、`im:message.group_at_msg`、`im:chat`、`im:resource`（附件必需）、`im:message:update`（卡片更新必需）
3. 事件与回调 → 订阅方式选 **「使用长连接接收事件」**，添加事件 `im.message.receive_v1`；如需卡片按钮点击，另订阅 `card.action.trigger`
4. 可用范围设为需要使用的成员/部门，发布版本

### 2. 环境变量

凭据全部来自环境变量（不写入配置文件）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `LARK_APP_ID` | 是 | 飞书应用 App ID |
| `LARK_APP_SECRET` | 是 | 飞书应用 App Secret |
| `LARK_WORKSPACE` | 否 | agent 工作目录（默认启动目录） |

模型 key 与 DSH 一致：`export DEEPSEEK_API_KEY=sk-xxx` 或写入 `$DSH_HOME/.credentials.yaml`。

### 3. 运行

```bash
LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx LARK_WORKSPACE=/path/to/work dsh --profile lark
```

看到 `[lark-bridge] Feishu long connection ready` 即连接成功。后台常驻用 `nohup ... &`；macOS 开机自启可配 launchd（参考仓库 `scripts/`）。

### 可调配置

在 `$DSH_HOME/profiles/lark/cordis.patch.yml` 的 `lark-bridge` 行下覆盖（常用）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `cardMode` | `true` | 卡片总开关（流式回复 + 问答/审批按钮卡片） |
| `replyToMentionOnly` | `true` | 群聊仅响应 @ 机器人的消息 |
| `ackEnabled` | `false` | 是否先回「⏳ 收到」确认 |
| `streaming.patchIntervalMs` | `700` | 卡片 PATCH 节流间隔（毫秒） |
| `streaming.showReasoning` | `true` | 卡片上展示思考过程 |
| `streaming.showToolCalls` | `true` | 卡片上展示工具调用面板 |
| `push.enabled` | `true` | 注册 `feishu_send` 主动推送工具 |
| `maxUploadBytes` | `104857600` | 附件大小上限（飞书上限 100MB） |

## 使用

- **单聊**：直接发消息；**群聊**：@机器人 后发消息
- 发图片/文件/视频/音频：自动下载处理，可附文字说明（如「这张图里有什么？」）
- 需要选择/审批时：点击卡片按钮，或直接回复编号/文字
- 命令：`/new` `/status` `/whoami` `/help`

## 测试

无需飞书应用与真实模型：

```bash
node test/streaming-test.mjs   # 单测：卡片构建 / TurnReporter / feishu_send
node test/smoke-test.mjs       # 端到端冒烟（mock 模型 + mock 飞书传输）
```

## License

MIT
