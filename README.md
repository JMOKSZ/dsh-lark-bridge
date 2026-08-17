# DSH 飞书入口（Lark Bridge）

让使用者通过**飞书机器人**远程使用 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness)：在飞书里给机器人发消息，机器人把消息交给运行在本机的 DSH agent 执行（读写文件、跑命令、搜索网页等），**全程用流式消息卡片**呈现处理过程（思考、工具调用、回答草稿实时更新），再把最终回答 sealed 进卡片回复到飞书。支持单聊与群聊（群聊需要 @机器人），每个会话（单聊或群）对应一个可跨重启恢复的 DSH session。

> 本质是一个 cordis 插件（`@jmoksz/lark-bridge`）+ 一个 DSH profile（`lark`）。不暴露任何端口，飞书消息通过官方**长连接**（WebSocket）到达，因此无需公网 IP、无需反向代理，在家/内网即可部署。

## 功能特性

- 📩 **消息收发**：文本消息 → DSH agent → 回答回复到原消息（先回「⏳ 收到」确认，完成后回最终答案）
- 🖼️ **图片解读**：用户发送的图片经「获取消息中的资源」API 下载，保存到上传目录；若当前模型支持图像输入（如视觉模型），图片会作为附件块直接附加给模型查看；否则 agent 可调用 `read_image` 等工具处理
- 📄 **文件处理**：文件（文档/表格/压缩包等）保存到上传目录，绝对路径随消息交给 agent，由 agent 用工具读取分析
- 🎬 **视频/音频**：下载保存到上传目录，agent 可用 ffprobe/ffmpeg 等工具提取信息或转码处理
- 📝 **富文本**：`post` 富文本消息自动提取纯文本
- 💬 **交互问答（v3.0）**：agent 需要你选择/确认时（`ask_user_question`、计划评审 `exit_plan_mode`），问题会带编号选项发到飞书，直接回复编号或文字即可，回合自动继续，不再卡死
- 🔐 **工具审批（v3.0）**：需要审批的操作（如沙箱提权）会把「批准/拒绝」请求发到飞书，回复「1/批准」或「2/拒绝」即可
- 🎴 **消息卡片（v3.1）**：开启 `cardMode` 后，问题/审批用飞书交互卡片呈现（选项按钮、批准/拒绝按钮），点击即作答；需租户管理员订阅 `card.action.trigger` 事件后按钮生效，未订阅时回复编号/文字兜底
- 🎞️ **流式回复卡片（v3.2，默认开启）**：`cardMode` 开启时，每条任务发一张「🤖 DSH 处理中…」实时卡片，随 agent 执行流式更新——思考过程、回答草稿、**工具调用面板**（每工具一行状态符号·工具名·参数摘要）实时 PATCH；完成后卡片 sealed 为绿色终态（含最终回复、用时、字数），出错则红色错误态。使用飞书原生 `streaming_mode`，客户端显示实时「生成中」
- 📨 **主动推送（v3.2）**：新增 `feishu_send` 工具，agent 可在任务进行中主动向当前会话或指定群/单聊推送文本或卡片（如中途汇报、结果分发、主动提醒）
- 🧵 **多会话**：每个飞书 chat（单聊或群）一个独立 DSH session，互不干扰
- ♻️ **跨重启恢复**：chat→session 映射持久化在 `$DSH_HOME/lark-bridge-state.json`，桥接重启后自动 `agents.resume()` 恢复上下文
- 👥 **群聊 @ 过滤**：默认只在被 @ 时才响应群消息（可关闭）
- ⏳ **排队**：同一会话多条消息按顺序处理
- 🛠 **命令**：`/new`（开新会话）、`/status`（会话/模型/队列/工作目录）、`/whoami`、`/help`
- 🔌 **双传输**：`transport: lark`（官方 SDK 长连接）与 `transport: mock`（本地 HTTP 桩，用于离线测试）

## 架构

```
飞书客户端 ──消息──▶ 飞书开放平台 ──长连接(WebSocket)──▶ lark-bridge 插件
   ▲                                                    │  （运行在 dsh --profile lark 进程内）
   │                                                    │  每条任务：流式卡片 create → PATCH 实时更新 → sealed
   └───────────卡片/文本回复（im.message.reply / interactive）◀─┘
                                                          │ 每个 chat_id 一个 DSH session
                                                          ▼
                                                     DSH agent（模型、工具、文件系统）
```

## 目录结构

| 路径 | 说明 |
|---|---|
| `lib/index.js` | 插件本体（cordis bundle：桥接 + 附件处理 + 流式卡片集成） |
| `lib/cards.js` | 纯函数卡片构建（问题/审批/流式/sealed 卡片） |
| `lib/answers.js` | 纯函数：问题/审批文本格式化与回复解析 |
| `lib/streaming.js` | v3.2 TurnReporter：流式卡片生命周期（事件驱动、节流 PATCH、退避/熔断） |
| `lib/push.js` | v3.2 `feishu_send` 主动推送工具定义 |
| `cordis.patch.yml` | 插件自带的 bundle 补丁（persona + 桥配置，装完即用，无需单独补丁文件） |
| `package.json` | 插件清单（`dsh.bundle` 声明 → 安装后自动成为 profile 层） |
| `scripts/setup-lark-profile.sh` | 本地开发用：创建/刷新 `$DSH_HOME/profiles/lark` |
| `test/` | 单测（`streaming-test.mjs`）+ 离线端到端冒烟（`smoke-test.mjs`，mock 模型 + mock 飞书传输） |
| `README.md` | 本文件 |

## 前置条件

- 本机已安装 **DSH CLI**（`dsh`，`npm i -g @deepseek-ai/dsh`）与 **pnpm**（`npm i -g pnpm`）
- Node.js ≥ 22
- 一个**飞书企业自建应用**（创建步骤见下），机器人能力已开启
- 一个可用的 LLM key（DSH 模型配置，见「模型配置」）

---

## 第一步：飞书开放平台配置（一次性）

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → 创建**企业自建应用**。
2. 在「应用能力」中添加 **机器人**。
3. 进入「凭证与基础信息」，记下 **App ID**（形如 `cli_xxx`）与 **App Secret**。
4. 「权限管理」中添加以下权限，然后**创建版本并发布**（自建应用发布后即时生效）：
   - `im:message` — 获取与发送单聊、群组消息
   - `im:message:send_as_bot` — 以应用的身份发消息
   - `im:message.group_at_msg` — 获取群组中所有消息（群聊 @ 场景需要）
   - `im:chat` — 获取群组信息
   - `im:resource` — 获取消息中的图片与文件资源（上传图片/文件/视频/音频**必需**）
5. 「事件与回调」→「事件配置」→ 添加事件 **`im.message.receive_v1`（接收消息）**；
   订阅方式务必选择 **「使用长连接接收事件」**（WebSocket 长连接，不需要填写回调地址）。
6. 「可用范围」设为需要使用的成员/部门；把机器人拉进目标群，或让使用者在飞书里搜索应用名并进入单聊。
7. 发布版本（如权限为「申请发布」，需管理员审批）。

> 官方文档参考：[事件概述](https://open.feishu.cn/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM.md?lang=zh-CN)、[机器人 FAQ](https://open.feishu.cn/document/faq/bot.md)。

## 第二步：安装（一条命令）

**同事/任何机器**：不需要 clone 本仓库，直接安装插件包（自动创建 `lark` profile）：

```bash
dsh plugin --profile lark add github:JMOKSZ/dsh-lark-bridge --ignore-scripts
```

> 也可从 npm 安装（发布后）：`dsh plugin --profile lark add @jmoksz/lark-bridge --ignore-scripts`。

插件自带 bundle 补丁（persona + 桥配置），安装即完成全部配置，**无需任何额外补丁文件**；`dsh plugin` 会自动把声明了 `dsh.bundle` 的 `@jmoksz/lark-bridge` 加入 `dsh.profile.bundles`。

**本地开发**：clone 后运行 `./scripts/setup-lark-profile.sh`（以 `file:` 方式安装本仓库副本，可重复执行以刷新代码）。

自定义 `DSH_HOME`（多套环境隔离时）：安装与运行时均 `export DSH_HOME=/path/to/home`。

## 第三步：配置

运行时的凭据全部来自**环境变量**（不写进任何配置文件，避免泄密）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `LARK_APP_ID` | 是 | 飞书应用 App ID（`cli_xxx`） |
| `LARK_APP_SECRET` | 是 | 飞书应用 App Secret |
| `LARK_WORKSPACE` | 否 | agent 的工作目录（默认取启动目录；`{{cwd}}` 与文件/命令工具都以它为准） |
| `DSH_TOOLS_MODE` | 否 | 工具模式（`native`/`code`/`both`），与 web 一致 |

也可以在 `$DSH_HOME/profiles/lark/cordis.patch.yml` 里写死（不推荐把 secret 放进文件；适合用密钥管理工具注入的场景）：

```yaml
- id: lark-bridge
  config:
    appId: cli_xxx
    appSecret: xxx
```

可调配置（都在 `cordis.patch.yml` 的 `lark-bridge` 行下）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `replyToMentionOnly` | `true` | 群聊仅响应 @ 机器人的消息；`false` 则响应群里所有消息 |
| `maxReplyChars` | `20000` | 回复截断上限（字符） |
| `ackEnabled` | `false` | 是否先回「⏳ 收到」确认（v3.2 起默认关闭：流式卡片本身就是即时反馈；纯文本模式或旧行为可重新开启） |
| `includeErrorDetails` | `true` | 出错时是否把错误码/信息带回飞书 |
| `workspace` | 启动目录 | agent 工作目录（等价于 `LARK_WORKSPACE`） |
| `transport` | `"lark"` | `"lark"` 或 `"mock"`（离线测试） |
| `uploadsDir` | `<workspace>/.lark-uploads` | 上传文件（图片/文件/视频/音频）的保存目录 |
| `imageMode` | `"attach"` | 图片处理方式：`"attach"` 在模型支持图像输入时附加图片块（并落盘）；`"file"` 只落盘、由 agent 用 `read_image` 等工具读取 |
| `maxUploadBytes` | `104857600`（100MB） | 单个附件大小上限（飞书资源接口上限 100MB） |
| `interactionEnabled` | `true` | 是否把 agent 的提问/审批转发到飞书（v3.0） |
| `interactionTimeoutMs` | `600000`（10分钟） | 等待用户回复的超时；超时后取消该交互并提示 |
| `agentPreset` | `"standard"` | agent 加入的预设（`standard` 提供 `ask_user_question` 与完整工具集）；`""` 表示不加入 |
| `cardMode` | `true` | v3.1+v3.2 卡片总开关：问题/审批按钮卡片 **+ 流式回复卡片**（思考/工具面板/回答草稿实时更新，完成后 sealed）。**问题/审批按钮点击需要租户管理员在开放平台订阅一次 `card.action.trigger` 事件（长连接）**；未订阅时按钮不可用，直接回复编号/文字仍可作答；卡片任一步失败自动回退纯文本 |
| `streaming.patchIntervalMs` | `700` | 流式卡片 PATCH 节流间隔（毫秒；飞书对卡片更新有频控） |
| `streaming.maxBodyChars` | `900` | 卡片正文单段截断上限（字符；卡片体积受限） |
| `streaming.showReasoning` | `true` | 是否在卡片上展示思考过程 |
| `streaming.showToolCalls` | `true` | 是否展示工具调用面板（每工具一行状态符号·工具名·参数摘要） |
| `streaming.cardTitleStreaming` | `"🤖 DSH 处理中…"` | 流式进行中的卡片标题 |
| `streaming.cardTitleDone` | `"🤖 DSH 处理完成"` | sealed 终态卡片标题 |
| `push.enabled` | `true` | 是否注册 `feishu_send` 工具（agent 主动推送） |
| `push.defaultChatId` | `""` | `feishu_send` 缺省推送目标 chat_id（空 = 当前会话） |

### 模型配置

桥接复用 DSH 的默认模型选择（`agent-default-model`，当前为 `deepseek-official/deepseek-v4-flash`）。与 web 完全一致，任选其一：

- **环境变量**：`export DEEPSEEK_API_KEY=sk-xxx`（DeepSeek 官方 API）
- **凭据文件**：在 `$DSH_HOME/.credentials.yaml` 写入 `DEEPSEEK_API_KEY: sk-xxx`（0600 权限，由 DSH 凭据服务管理）
- **其他模型**：在 `$DSH_HOME/settings.yaml` 配置 `llm-pi-ai.providers` 或 `llm-deepseek` 段，并在 `cordis.patch.yml` 覆盖 `agent-default-model` 行

> **视觉模型**：要让机器人直接“看懂”图片（图片块附加给模型），请配置声明了 `image` 输入模态的模型（如 OpenAI 系多模态模型，经 `llm-pi-ai` 网关接入）。当前 DeepSeek 官方 API 模型为纯文本：图片会落盘，agent 可调用 `read_image` 工具读取（工具对模型能力有同样的门控），或由你切换视觉模型后自动升级为直接看图。

## 第四步：运行

### 前台运行（调试）

```bash
LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx LARK_WORKSPACE=/path/to/work dsh --profile lark
```

看到 `[lark-bridge] Feishu long connection ready` 即连接成功。

### 后台常驻（nohup）

```bash
nohup env LARK_APP_ID=cli_xxx LARK_APP_SECRET=xxx LARK_WORKSPACE=/path/to/work \
  dsh --profile lark >> /tmp/lark-bridge.log 2>&1 &
```

### macOS 开机自启（launchd）

把以下 plist 保存为 `~/Library/LaunchAgents/com.jmoksz.dsh-lark-bridge.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.jmoksz.dsh-lark-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/你的用户名/.npm-global/bin/dsh</string>
    <string>--profile</string>
    <string>lark</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/work</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LARK_APP_ID</key><string>cli_xxx</string>
    <key>LARK_APP_SECRET</key><string>xxx</string>
    <key>LARK_WORKSPACE</key><string>/path/to/work</string>
    <key>DEEPSEEK_API_KEY</key><string>sk-xxx</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/lark-bridge.log</string>
  <key>StandardErrorPath</key><string>/tmp/lark-bridge.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.jmoksz.dsh-lark-bridge.plist   # 加载并启动
launchctl unload ~/Library/LaunchAgents/com.jmoksz.dsh-lark-bridge.plist # 停止
```

> Linux 可用 systemd 的 `[Service] ExecStart=` + `Environment=` 达到同样效果。

## 第五步：在飞书里使用

- **单聊**：直接发文字消息。
- **群聊**：@机器人 后发消息（默认只响应被 @ 的消息）。
- **流式回复卡片（v3.2 默认）**：每条任务发一张「🤖 DSH 处理中…」实时卡片，随处理过程实时更新——思考、工具调用面板（🛠️ 状态符号·工具名·参数摘要）、回答草稿逐段出现；完成后卡片变为绿色终态（最终回复 + 用时 + 字数），出错为红色错误态。期间你看到的就是卡片在“干活”，无需等待沉默。
- **主动推送**：任务进行中 agent 可用 `feishu_send` 主动向会话推送消息/卡片（如中途汇报、结果分发）。
- **上传文件**：直接发送图片 / 文件 / 视频 / 音频即可。桥接会下载资源并处理：
  - 图片 → 保存到上传目录，视觉模型下直接附加给模型“看图”（也可配合文字说明）；
  - 文件 / 视频 / 音频 → 保存到上传目录，agent 用工具读取、分析或转码；
  - 可同时发一条文字说明，例如：`这张图里有什么？`、`帮我整理这个 Excel 的月度汇总`、`这个视频有多长、分辨率多少？`。
- **交互问答（v3.0）**：当 agent 需要你选择/确认/审批时，机器人会发来带编号选项的按钮卡片（或「批准/拒绝」卡片）：
  - 直接**点击卡片按钮**即作答（需已订阅 `card.action.trigger`）；
  - 或回复编号（如 `1`）/选项文字/自定义内容；
  - 多选：回复多个编号（逗号分隔）；
  - 多题一批：按 `1. 回答`、`2. 回答` 逐行回复；
  - 审批：点「✅ 批准 / 🚫 拒绝」或回复 `1`/`批准`/`允许`、`2`/`拒绝`。
  - 回复后 agent 会继续执行，无需重新发起任务；等待期间命令（`/status` 等）仍可用。
- 命令：
  - `/new` — 开启新会话（清空本会话上下文）
  - `/status` — 查看会话 ID、模型、排队数、工作目录、上传目录
  - `/whoami` — 查看你的 open_id / chat_id
  - `/help` — 帮助

示例：`帮我看看当前目录下有哪些文件`、`运行测试并把结果告诉我`、`把这段需求写成一个 TODO 清单`、`这张截图里写了什么`、`分析这份财务报表并给我摘要`。

## 测试（离线）

不需要飞书应用、不需要真实模型：

```bash
node test/streaming-test.mjs   # 单元测试：卡片构建 / TurnReporter / feishu_send
node test/smoke-test.mjs       # 端到端冒烟（mock 模型 + mock 飞书传输）
```

覆盖：profile 启动、消息→agent→回复（mock 模型）、群聊 @ 过滤、会话跨消息恢复、`/new` 重开会话、状态持久化、图片上传（落盘 + 附件块）、文件上传、富文本提取、交互问答全链路（问题转发 → 回答 → 回合继续）、答案解析与审批关键词、**流式卡片生命周期（create → PATCH → sealed）**、**工具面板渲染**、**`feishu_send` 主动推送端到端**。预期输出：单测 `39/39`、冒烟 `33/33 checks passed`。

## 更新插件

```bash
cd dsh-lark-bridge && git pull
./scripts/setup-lark-profile.sh     # 重装插件副本
# 重启桥接进程
```

## 安全说明

- **不要把凭据提交进仓库**：`LARK_APP_ID` / `LARK_APP_SECRET` / `DEEPSEEK_API_KEY` 等一律通过环境变量或 `$DSH_HOME/.credentials.yaml` 注入；`.gitignore` 已排除 `.env`、`*.pem`、`lark-bridge-state.json`。
- 群聊默认需 @，避免被无关消息触发；上传目录（`.lark-uploads`）会被 agent 读取，请把上传目录放在可信任的位置。
- 上传的文件会保存在工作区（默认 `<workspace>/.lark-uploads`），与 DSH 会话日志一样属于本机数据；如需清理可定期删除该目录。
- 回复内容可能包含 agent 读取到的本地文件信息，请控制「可用范围」与「@ 权限」。

## 排错

| 现象 | 处理 |
|---|---|
| 启动报 `LARK_APP_ID / LARK_APP_SECRET are required` | 未设置凭据，见「第三步：配置」 |
| 长连接一直重连 / `onError` | 确认开放平台事件订阅方式为「长连接」，应用已发布，可用范围包含当前租户 |
| 群聊不响应 | 确认已 @ 机器人、机器人在群内、`im:message.group_at_msg` 权限已发布 |
| 发送图片/文件后回复「💾 下载附件失败」 | 确认 `im:resource` 权限已添加并**重新发布版本** |
| 图片没附加给模型（日志提示 no image input） | 当前模型为纯文本模型；配置视觉模型（声明 `image` 输入）后自动升级 |
| 回复报 `MISSING_CREDENTIAL` | 模型 key 未配置：`DEEPSEEK_API_KEY` 或 `$DSH_HOME/.credentials.yaml` |
| 机器人回复「💥 任务出错」 | 看桥接进程日志中的错误码；`includeErrorDetails: true` 时错误码会直接带回飞书 |
| 卡片只显示初始「处理中」不更新 | 确认 `im:message:update` 权限已添加并重新发布；PATCH 频控可调 `streaming.patchIntervalMs` |
| 卡片始终显示「🤖 DSH 处理中…」不 sealed | 看日志 `card patch failed` / `breaker tripped`；多为权限或频控问题，已自动降级文本回复 |
| 进程没日志 | 日志走 stdout/stderr，用 nohup/launchd 重定向到文件查看 |

## 已知限制（v0.6）

- 表情包（sticker）与合并转发/卡片消息暂不支持（飞书资源接口本身限制）。
- 附件上限 100MB（飞书接口限制），可经 `maxUploadBytes` 调低。
- 图片附加给模型依赖模型声明 `image` 输入模态；纯文本模型下图片落盘 + `read_image` 工具兜底。
- **卡片按钮**（`cardMode: true`）需要租户管理员在开放平台订阅一次 `card.action.trigger` 事件（长连接）；未订阅时按钮点击无效，但直接回复编号/文字仍可作答。
- 流式卡片是**增强**：任一步（创建/PATCH）失败自动回退纯文本回复，不影响任务执行；连续 PATCH 失败会熔断降级。
- 卡片正文受 `streaming.maxBodyChars` 截断（思考/草稿只保留尾部摘要）；工具面板参数摘要同样截断。
- `feishu_send` 推送失败不会中断回合——工具返回错误结果，由 agent 决定是否重试或改用当前会话。
- 群聊共享一个会话上下文（同群所有人共用），不同群/单聊彼此隔离。
- 交互等待期间，该 chat 的下一条文本消息会被当作回答（可用 `/` 命令打断）。
- 回复超过 `maxReplyChars`（默认 20000 字符）会被截断（sealed 卡片内同样适用）。

## License

MIT
