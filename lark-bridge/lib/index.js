// @dsh/lark-bridge — Feishu (Lark) entry point for DSH.
//
// A cordis plugin that subscribes to Feishu IM events over the long
// connection (WebSocket) and drives a DSH agent per chat. Each Feishu chat
// (p2p or group) maps to one durable DSH session; every text message is
// submitted as a user turn and the final assistant answer is replied back to
// the original message. A small command surface (/new, /status, /help,
// /whoami) manages the per-chat sessions.
//
// The plugin is transport-shaped: `transport: "lark"` uses the official
// @larksuiteoapi/node-sdk WSClient; `transport: "mock"` runs a local HTTP
// stub (POST /incoming, GET /outgoing) so the bridge can be exercised end to
// end without a Feishu app.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import * as lark from "@larksuiteoapi/node-sdk";

/** Stable Cordis plugin name. */
const name = "lark-bridge";
/** Core services required before the bridge can drive turns. */
const inject = ["agentDefaultModel", "agents", "sessions"];

const Config = z.object({
  appId: z.string(),
  appSecret: z.string(),
  botOpenId: z.string(),
  transport: z.union([z.const("lark"), z.const("mock")]).default("lark"),
  mockPort: z.number().default(4780),
  mockOutgoingFile: z.string().default(""),
  replyToMentionOnly: z.boolean().default(true),
  workspace: z.string().default(process.cwd()),
  maxReplyChars: z.number().default(20000),
  stateFile: z.string().default(""),
  includeErrorDetails: z.boolean().default(true),
  ackEnabled: z.boolean().default(true)
});

const HELP_TEXT = [
  "🤖 DSH 飞书入口",
  "",
  "直接把想做的事发给机器人即可，例如：",
  "  · 分析当前工作目录的测试覆盖率",
  "  · 运行测试并把结果告诉我",
  "  · 帮我写一份周报草稿",
  "",
  "命令：",
  "  /new       开启新会话（清空本会话的上下文）",
  "  /status    查看当前会话、模型与工作目录",
  "  /whoami    查看我的 open_id / chat_id",
  "  /help      显示本帮助"
].join("\n");

function makeLogger(ctx) {
  // Mirror every message to stdout/stderr as well as the cordis logger, so a
  // long-running bridge produces visible logs even without a logger sink.
  // Call sites already carry the "[lark-bridge]" prefix in their messages.
  const cordis = ctx.logger;
  const out = (method, args) => {
    try {
      console[method === "error" ? "error" : "log"](...args);
    } catch {
      /* ignore console failures */
    }
    try {
      cordis?.[method]?.(...args);
    } catch {
      /* ignore cordis logger failures */
    }
  };
  return {
    info: (...args) => out("info", args),
    warn: (...args) => out("warn", args),
    error: (...args) => out("error", args)
  };
}

/** Join the text blocks of an assistant message content. */
function assistantText(content) {
  return (content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Aggregate the last assistant text and the turn outcome (mirrors dsh-headless). */
function summarize(events, firstSeq) {
  let started = false;
  let text = "";
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = assistantText(event.data.message.content);
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data.reason;
  }
  return { text, reason };
}

/** Extract plain text from a Feishu text-message payload and drop mention markup. */
function textOfMessage(message) {
  if (message.message_type !== "text") return null;
  let content;
  try {
    content = JSON.parse(message.content);
  } catch {
    content = null;
  }
  const raw = typeof content?.text === "string" ? content.text : String(message.content ?? "");
  return raw
    .replace(/<at\s+[^>]*>[\s\S]*?<\/at>/g, " ")
    .replace(/@_user_\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Truncate an over-long reply and say so. */
function truncate(text, max) {
  if (max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…（内容过长，已截断到 ${max} 字符）`;
}

/** Real transport: the official SDK's long-connection client plus IM APIs. */
class LarkTransport {
  constructor({ appId, appSecret, logger }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.logger = logger;
    this.client = null;
    this.ws = null;
    this.onIncoming = null;
  }

  async start(onIncoming) {
    this.onIncoming = onIncoming;
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.INFO
    });
    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": (data) => {
        this.onIncoming?.(data).catch((error) => {
          this.logger.warn(`[lark-bridge] incoming handler failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        });
      }
    });
    this.ws = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.INFO,
      onReady: () => this.logger.info("[lark-bridge] Feishu long connection ready"),
      onError: (error) => this.logger.warn(`[lark-bridge] Feishu long connection error: ${error.message}`),
      onReconnecting: () => this.logger.warn("[lark-bridge] Feishu long connection reconnecting"),
      onReconnected: () => this.logger.info("[lark-bridge] Feishu long connection reconnected")
    });
    await this.ws.start({ eventDispatcher: dispatcher });
  }

  /** The bot's own open_id, used for group mention filtering. */
  async fetchBotOpenId() {
    try {
      const response = await this.client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
      return response?.bot?.open_id;
    } catch (error) {
      this.logger.warn(`[lark-bridge] could not fetch the bot open_id (${error instanceof Error ? error.message : String(error)}); group mention filtering may be unavailable`);
      return undefined;
    }
  }

  async reply(messageId, text) {
    await this.client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "text", content: JSON.stringify({ text }) }
    });
  }

  async create(chatId, text) {
    await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) }
    });
  }

  stop() {
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }
}

/** Mock transport: a local HTTP stub for offline end-to-end tests. */
class MockTransport {
  constructor({ port, outgoingFile, logger }) {
    this.port = port;
    this.outgoingFile = outgoingFile;
    this.logger = logger;
    this.outgoing = [];
    this.server = null;
    this.onIncoming = null;
  }

  async start(onIncoming) {
    this.onIncoming = onIncoming;
    const { createServer } = await import("node:http");
    this.server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (req.method === "POST" && url === "/incoming") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            this.onIncoming?.(payload).catch((error) => {
              this.logger.warn(`[lark-bridge] mock incoming handler failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
            });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch (error) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: String(error) }));
          }
        });
      } else if (req.method === "GET" && url === "/outgoing") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(this.outgoing));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((done) => this.server.listen(this.port, "127.0.0.1", done));
    this.logger.info(`[lark-bridge] mock transport listening on http://127.0.0.1:${this.port}`);
  }

  record(entry) {
    this.outgoing.push(entry);
    if (this.outgoingFile) {
      appendFileSync(this.outgoingFile, JSON.stringify(entry) + "\n");
    }
  }

  reply(messageId, text) {
    this.record({ kind: "reply", message_id: messageId, text });
  }

  create(chatId, text) {
    this.record({ kind: "create", chat_id: chatId, text });
  }

  async fetchBotOpenId() {
    return undefined;
  }

  stop() {
    try {
      this.server?.close();
    } catch {
      /* already closed */
    }
  }
}

/** The per-chat DSH bridge. */
class Bridge {
  constructor({ ctx, config, logger }) {
    this.ctx = ctx;
    this.config = config;
    this.logger = logger;
    this.transport = null;
    this.chats = new Map(); // chatId -> { handle, busy, queue }
    this.chatBySession = new Map(); // sessionId string -> chatId
    this.state = { chats: {}, botOpenId: "" };
    this.recentMessageIds = new Set();
  }

  async start() {
    this.loadState();
    this.transport = this.config.transport === "mock"
      ? new MockTransport({ port: this.config.mockPort, outgoingFile: this.config.mockOutgoingFile, logger: this.logger })
      : new LarkTransport({ appId: this.config.appId, appSecret: this.config.appSecret, logger: this.logger });
    await this.transport.start((data) => this.handleIncoming(data));
    const configured = this.config.botOpenId || "";
    const fetched = configured === "" ? await this.transport.fetchBotOpenId() : undefined;
    const persisted = this.state.botOpenId || "";
    const next = configured || fetched || persisted || "";
    if (next !== this.state.botOpenId) {
      this.state.botOpenId = next;
      this.saveState();
    }
    this.logger.info(`[lark-bridge] started transport=${this.config.transport} workspace=${this.config.workspace} state=${this.config.stateFile}`);
  }

  loadState() {
    const file = this.config.stateFile;
    if (!file || !existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") {
        this.state.chats = parsed.chats ?? {};
        this.state.botOpenId = parsed.botOpenId ?? "";
      }
    } catch (error) {
      this.logger.warn(`[lark-bridge] could not read state file ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  saveState() {
    const file = this.config.stateFile;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n");
      renameSync(tmp, file);
    } catch (error) {
      this.logger.warn(`[lark-bridge] could not write state file ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  rememberMessageId(id) {
    this.recentMessageIds.add(id);
    if (this.recentMessageIds.size > 500) {
      const first = this.recentMessageIds.values().next().value;
      this.recentMessageIds.delete(first);
    }
  }

  isBotMentioned(message) {
    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    if (mentions.some((m) => m.mentioned_type === "app")) return true;
    const bot = this.state.botOpenId;
    if (!bot) return false;
    return mentions.some((m) => {
      const id = m.id ?? {};
      return id.open_id === bot || id.union_id === bot || id.user_id === bot;
    });
  }

  async safeReply(chatId, messageId, text) {
    try {
      await this.transport.reply(messageId, text);
      this.logger.info(`[lark-bridge] replied to ${chatId} (${messageId}): ${text.slice(0, 60).replace(/\n/g, " ")}`);
    } catch (error) {
      this.logger.warn(`[lark-bridge] reply to ${chatId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async handleIncoming(data) {
    const message = data?.message;
    const sender = data?.sender;
    if (!message || !sender) return;
    const messageId = message.message_id;
    if (!messageId || this.recentMessageIds.has(messageId)) return;
    this.rememberMessageId(messageId);
    // The bot's own messages come back through the same channel.
    if (sender.sender_type === "app") return;

    const chatId = message.chat_id;
    const isGroup = message.chat_type === "group";
    if (isGroup && this.config.replyToMentionOnly && !this.isBotMentioned(message)) return;

    if (message.message_type !== "text") {
      await this.safeReply(chatId, messageId, "📝 目前只支持文本消息，请直接输入文字。");
      return;
    }

    const text = textOfMessage(message);
    if (text === "") return;
    if (text.startsWith("/")) {
      await this.handleCommand(chatId, messageId, sender, text);
      return;
    }
    await this.enqueue(chatId, messageId, text);
  }

  async handleCommand(chatId, messageId, sender, text) {
    const cmd = text.split(/\s+/)[0];
    switch (cmd) {
      case "/new": {
        await this.resetChat(chatId);
        await this.safeReply(chatId, messageId, "✅ 已开启新会话，接下来我会基于全新上下文工作。");
        break;
      }
      case "/status": {
        const chat = this.chats.get(chatId);
        const sessionId = chat?.handle ? String(chat.handle.agent.session.id) : "（尚无）";
        const model = await this.currentModelLabel();
        const queue = chat ? chat.queue.length : 0;
        await this.safeReply(chatId, messageId, `📊 状态\n· 会话: ${sessionId}\n· 模型: ${model}\n· 排队消息: ${queue}\n· 工作目录: ${this.config.workspace}`);
        break;
      }
      case "/whoami": {
        const openId = sender.sender_id?.open_id ?? "?";
        await this.safeReply(chatId, messageId, `👤 open_id: ${openId}\n💬 chat_id: ${chatId}`);
        break;
      }
      case "/help":
        await this.safeReply(chatId, messageId, HELP_TEXT);
        break;
      default:
        await this.safeReply(chatId, messageId, `❓ 未知命令 ${cmd}\n\n发送 /help 查看可用命令。`);
        break;
    }
  }

  async currentModelLabel() {
    const defaultModel = this.ctx.get("agentDefaultModel");
    try {
      const selection = defaultModel?.currentSelection();
      if (selection?.provider) return `${selection.provider}/${selection.model}`;
    } catch {
      /* fall through */
    }
    return "（未配置）";
  }

  async enqueue(chatId, messageId, text) {
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = { handle: null, busy: false, queue: [] };
      this.chats.set(chatId, chat);
    }
    chat.queue.push({ messageId, text });
    if (this.config.ackEnabled) {
      await this.safeReply(chatId, messageId, "⏳ 收到，DSH 正在处理（复杂任务可能需要几分钟）…");
    }
    await this.drain(chatId);
  }

  async drain(chatId) {
    const chat = this.chats.get(chatId);
    if (!chat || chat.busy) return;
    chat.busy = true;
    try {
      while (chat.queue.length > 0) {
        const item = chat.queue.shift();
        try {
          await this.runTurn(chatId, chat, item);
        } catch (error) {
          this.logger.error(`[lark-bridge] turn failed for chat ${chatId}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
          await this.safeReply(chatId, item.messageId, `💥 处理失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } finally {
      chat.busy = false;
    }
  }

  async ensureChatAgent(chatId) {
    const agents = this.ctx.get("agents");
    const defaultModel = this.ctx.get("agentDefaultModel");
    await this.ctx.get("loader")?.await();
    const selection = defaultModel.currentSelection();
    if (!selection?.provider || !selection.model) {
      throw new Error("没有可用的默认模型：请先在 DSH 配置模型（agent-default-model 或 llm 设置），再重试");
    }
    const agentOptions = { provider: selection.provider, model: selection.model };
    const setup = (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: void 0 });
    };

    const savedSessionId = this.state.chats[chatId];
    if (savedSessionId) {
      try {
        const handle = await agents.resume({ resumeSessionId: SessionId(savedSessionId), agentOptions, setup });
        this.logger.info(`[lark-bridge] resumed session ${savedSessionId} for chat ${chatId}`);
        return handle;
      } catch (error) {
        this.logger.warn(`[lark-bridge] resume of ${savedSessionId} failed (${error instanceof Error ? error.message : String(error)}); creating a fresh session`);
        delete this.state.chats[chatId];
        this.saveState();
      }
    }
    const sessionId = SessionId(`session-${randomUUID()}`);
    const handle = await agents.create({ sessionId, meta: { cwd: this.config.workspace }, agentOptions, setup });
    this.state.chats[chatId] = String(sessionId);
    this.saveState();
    this.logger.info(`[lark-bridge] created session ${sessionId} for chat ${chatId}`);
    return handle;
  }

  async runTurn(chatId, chat, item) {
    const agents = this.ctx.get("agents");
    const sessions = this.ctx.get("sessions");
    if (!agents || !sessions) throw new Error("core services not ready (agents/sessions)");

    let handle = chat.handle;
    if (!handle) {
      handle = await this.ensureChatAgent(chatId);
      chat.handle = handle;
      this.chatBySession.set(String(handle.agent.session.id), chatId);
    }
    const agent = handle.agent;
    const startedAt = Date.now();
    this.logger.info(`[lark-bridge] turn start for ${chatId} (${item.messageId}): ${item.text.slice(0, 60).replace(/\n/g, " ")}`);

    await agent.whenIdle();
    const firstSeq = agent.session.seq;
    agent.followup(createUserMessage({
      content: [{ type: "text", text: item.text }],
      source: { kind: "user" }
    }));
    await agent.whenIdle();
    await sessions.flush(agent.session);

    const outcome = summarize(agent.session.events, firstSeq);
    let replyText;
    if (outcome.reason?.kind === "error") {
      const detail = this.config.includeErrorDetails
        ? `\n\n(${outcome.reason.error.code}: ${outcome.reason.error.message})`
        : "";
      replyText = `💥 任务出错${detail}`;
    } else if (outcome.text !== "") {
      replyText = outcome.text;
    } else {
      replyText = "✅ 完成（没有文本输出）。";
    }
    await this.safeReply(chatId, item.messageId, truncate(replyText, this.config.maxReplyChars));
    this.logger.info(`[lark-bridge] turn end for ${chatId} (${item.messageId}) in ${Date.now() - startedAt}ms; reason=${outcome.reason?.kind ?? "?"}`);
  }

  async resetChat(chatId) {
    const chat = this.chats.get(chatId);
    if (chat?.handle) {
      try {
        await chat.handle.dispose();
      } catch (error) {
        this.logger.warn(`[lark-bridge] dispose of chat ${chatId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.chatBySession.delete(String(chat.handle.agent.session.id));
      chat.handle = null;
    }
    delete this.state.chats[chatId];
    this.saveState();
  }

  async dispose() {
    this.transport?.stop();
    for (const chat of this.chats.values()) {
      if (chat.handle) {
        try {
          await chat.handle.dispose();
        } catch {
          /* already disposed */
        }
      }
    }
    this.chats.clear();
    this.chatBySession.clear();
  }
}

/**
 * Mount the Feishu bridge.
 * @param ctx - plugin context carrying core services.
 * @param config - validated bridge config.
 */
function apply(ctx, config) {
  const logger = makeLogger(ctx);
  const appId = config.appId ?? process.env.LARK_APP_ID;
  const appSecret = config.appSecret ?? process.env.LARK_APP_SECRET;
  if (config.transport !== "mock" && (!appId || !appSecret)) {
    throw new Error("lark-bridge: LARK_APP_ID / LARK_APP_SECRET are required — set them in the profile cordis.patch.yml or export them in the launching environment");
  }
  const workspace = resolve(config.workspace || process.env.LARK_WORKSPACE || process.cwd());
  mkdirSync(workspace, { recursive: true });
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const bridge = new Bridge({
    ctx,
    config: {
      ...config,
      appId,
      appSecret,
      workspace,
      stateFile: config.stateFile || join(home, "lark-bridge-state.json")
    },
    logger
  });
  ctx.on("dispose", () => {
    void bridge.dispose();
  });
  void bridge.start().catch((error) => {
    logger.error(`[lark-bridge] failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    const exit = ctx.get("appExit");
    if (exit) exit(1);
    else process.exitCode = 1;
  });
}

export { Config, apply, inject, name };
