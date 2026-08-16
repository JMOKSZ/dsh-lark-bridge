// @dsh/lark-bridge — Feishu (Lark) entry point for DSH.
//
// A cordis plugin that subscribes to Feishu IM events over the long
// connection (WebSocket) and drives a DSH agent per chat. Each Feishu chat
// (p2p or group) maps to one durable DSH session; every text message is
// submitted as a user turn and the final assistant answer is replied back to
// the original message. A small command surface (/new, /status, /help,
// /whoami) manages the per-chat sessions.
//
// v2.0 — attachments: image / file / video / audio messages are downloaded
// through the message-resource API, saved under the uploads directory, and
// included in the user turn: images are additionally attached as image
// blocks when the current model declares image input (the same capability
// gate the read_image tool enforces); other resources reach the agent as
// absolute paths it can process with its tools. Post (rich text) messages are
// reduced to their plain text.
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
import { UserQuestionError } from "@deepseek-ai/dsh-user-questions";
import * as lark from "@larksuiteoapi/node-sdk";
import { formatApproval, formatQuestions, parseApprovalOutcome, parseBatch } from "./answers.js";
import { answeredApprovalCard, answeredQuestionCard, approvalCard, isButtonCompatible, questionCard } from "./cards.js";

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
  ackEnabled: z.boolean().default(true),
  // v2.0 attachment options.
  uploadsDir: z.string().default(""),
  imageMode: z.union([z.const("attach"), z.const("file")]).default("attach"),
  maxUploadBytes: z.number().default(100 * 1024 * 1024),
  // v3.0 interaction options.
  interactionEnabled: z.boolean().default(true),
  interactionTimeoutMs: z.number().default(10 * 60 * 1000),
  // The agent preset agents join (standard brings ask_user_question and the
  // full coding-agent tool set); set "" to join no preset.
  agentPreset: z.string().default("standard"),
  // v3.1: render interactions as Feishu interactive cards with buttons when
  // possible; card button callbacks need the tenant admin to subscribe the
  // card.action.trigger event (long connection) once — until then replies via
  // plain text still work (the card degrades to a static prompt). Defaults to
  // off so a zero-config deployment uses plain-text interactions.
  cardMode: z.boolean().default(false)
});

/** Feishu channel instructions injected into every agent's system prompt. */
const CHANNEL_INSTRUCTIONS = [
  "You are reached remotely through a Feishu bot: reply concisely in the same language the user wrote in, keep answers suitable for a chat window, and say what you actually did.",
  "When the user uploads images, files, videos or audio, their absolute paths are included in your instructions and the bytes live under the uploads directory; inspect and process them with your tools (read_image, bash, file tools, ffprobe/ffmpeg for media), then summarize what you found.",
  "If you cannot actually see an uploaded image with your tools and model capabilities (for example a text-only model without a working image tool), say so honestly and tell the user what you could and could not determine — never describe visual content you have not actually seen."
].join(" ");

const HELP_TEXT = [
  "🤖 DSH 飞书入口",
  "",
  "直接把想做的事发给机器人即可，例如：",
  "  · 分析当前工作目录的测试覆盖率",
  "  · 运行测试并把结果告诉我",
  "  · 帮我写一份周报草稿",
  "",
  "也可以发送图片、文件、视频/音频，我会下载并处理：",
  "  · 图片：附加给支持视觉的模型解读，并保存到上传目录",
  "  · 文件/视频/音频：保存到上传目录，由 agent 用工具分析",
  "",
  "当需要你选择、确认、审批时，我会把问题发到群里/单聊里，",
  "你直接回复编号或文字即可，不用重发任务。",
  "",
  "命令：",
  "  /new       开启新会话（清空本会话的上下文）",
  "  /status    查看当前会话、模型与工作目录",
  "  /whoami    查看我的 open_id / chat_id",
  "  /help      显示本帮助"
].join("\n");

const UPLOAD_SUBDIR = ".lark-uploads";

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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
  const content = parseMessageContent(message.content);
  const raw = typeof content?.text === "string" ? content.text : String(message.content ?? "");
  return raw
    .replace(/<at\s+[^>]*>[\s\S]*?<\/at>/g, " ")
    .replace(/@_user_\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse a Feishu message content JSON defensively. */
function parseMessageContent(content) {
  try {
    const parsed = JSON.parse(content ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Reduce a `post` (rich text) message to its plain text. */
function textOfPost(content) {
  const parsed = parseMessageContent(content);
  const parts = [];
  for (const row of Array.isArray(parsed.content) ? parsed.content : []) {
    for (const node of Array.isArray(row) ? row : []) {
      if (node?.tag === "text" && typeof node.text === "string") parts.push(node.text);
      else if (node?.tag === "a" && typeof node.text === "string") parts.push(`${node.text}${typeof node.href === "string" ? ` (${node.href})` : ""}`);
    }
  }
  const title = typeof parsed.title === "string" ? parsed.title : "";
  return [title, parts.join("")].filter(Boolean).join("\n").trim();
}

/** Map a message type + content to the message-resource download `type`. */
function resourceTypeOf(messageType, content) {
  switch (messageType) {
    case "image":
      return "image";
    case "file":
      return "file";
    case "media": {
      const name = String(content.file_name ?? "").toLowerCase();
      if (/\.(mp3|wav|aac|amr|flac|ogg|m4a|opus)$/.test(name)) return "audio";
      return "video";
    }
    default:
      return null;
  }
}

function labelOfKind(kind) {
  switch (kind) {
    case "image":
      return "图片";
    case "file":
      return "文件";
    case "media":
      return "媒体文件";
    default:
      return kind;
  }
}

/** Detect one of the four attachment-supported image media types by magic bytes. */
function detectImageMediaType(bytes, name) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  const lower = String(name ?? "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return null;
}

function extOf(name, mediaType) {
  const match = String(name ?? "").match(/(\.[A-Za-z0-9]{1,10})$/);
  if (match) return match[1].toLowerCase();
  switch (mediaType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return "";
  }
}

/** Sanitize an uploaded file name: no path separators, no control chars. */
function safeFilename(name, ext) {
  const base = String(name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim() || `upload_${randomUUID().slice(0, 8)}`;
  const cleaned = base.length > 120 ? base.slice(0, 120) : base;
  return ext && !cleaned.toLowerCase().endsWith(ext) ? `${cleaned}${ext}` : cleaned;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Truncate an over-long reply and say so. */
function truncate(text, max) {
  if (max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…（内容过长，已截断到 ${max} 字符）`;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
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

  async start(onIncoming, onCardAction) {
    this.onIncoming = onIncoming;
    this.onCardAction = onCardAction;
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
      },
      "card.action.trigger": (data) => {
        this.onCardAction?.(data).catch((error) => {
          this.logger.warn(`[lark-bridge] card action handler failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
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

  /** Send an interactive card to a chat; returns the new message id. */
  async sendCard(chatId, card) {
    const response = await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) }
    });
    return response?.data?.message_id;
  }

  /** Replace an existing card message's content. */
  async patchCard(messageId, card) {
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) }
    });
  }

  /** The bot's own open_id, used for group mention filtering. */
  async fetchBotOpenId() {
    try {
      const response = await this.client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
      return response?.bot?.open_id;
    } catch (error) {
      this.logger.warn(`[lark-bridge] could not fetch the bot open_id (${errorMessage(error)}); group mention filtering may be unavailable`);
      return undefined;
    }
  }

  /**
   * Download a user-sent resource (image/file/video/audio) through the
   * message-resource API. Returns `{ bytes, name?, mediaType? }` or null when
   * the message carries no downloadable key.
   */
  async downloadResource(message) {
    const content = parseMessageContent(message.content);
    const type = resourceTypeOf(message.message_type, content);
    if (type === null) return null;
    const fileKey = content.image_key ?? content.file_key;
    if (!fileKey) return null;
    const candidates = type === "video" || type === "audio"
      ? [type, type === "video" ? "audio" : "video"]
      : [type];
    let lastError;
    for (const candidate of candidates) {
      try {
        const result = await this.client.im.messageResource.get({
          params: { type: candidate },
          path: { message_id: message.message_id, file_key: fileKey }
        });
        const bytes = await streamToBuffer(result.getReadableStream());
        const mediaType = result.headers?.["content-type"];
        return { bytes, name: content.file_name, mediaType };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("message carries no downloadable resource");
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

  async start(onIncoming, onCardAction) {
    this.onIncoming = onIncoming;
    this.onCardAction = onCardAction;
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
            if (payload.kind === "card_action") {
              // Simulate a Feishu card.action.trigger callback.
              const callbackPayload = {
                context: { open_message_id: payload.message_id, open_chat_id: payload.chat_id },
                operator: { open_id: payload.open_id ?? "ou_test_user" },
                action: { value: payload.value, tag: "button" }
              };
              this.onCardAction?.(callbackPayload)
                .then((result) => {
                  res.writeHead(200, { "content-type": "application/json" });
                  res.end(JSON.stringify(result ?? { ok: true }));
                })
                .catch((error) => {
                  res.writeHead(500, { "content-type": "application/json" });
                  res.end(JSON.stringify({ ok: false, error: String(error) }));
                });
              return;
            }
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

  /** Serve test resources from `message.mockResource` (base64 / filePath / text). */
  async downloadResource(message) {
    const mock = message.mockResource;
    if (!mock) return null;
    let bytes;
    if (typeof mock.base64 === "string") bytes = Buffer.from(mock.base64, "base64");
    else if (typeof mock.filePath === "string") bytes = readFileSync(mock.filePath);
    else if (typeof mock.text === "string") bytes = Buffer.from(mock.text, "utf8");
    else return null;
    return { bytes, name: mock.fileName ?? "mock-upload.bin", mediaType: mock.mediaType };
  }

  record(entry) {
    this.outgoing.push(entry);
    if (this.outgoingFile) {
      appendFileSync(this.outgoingFile, JSON.stringify(entry) + "\n");
    }
  }

  async reply(messageId, text) {
    this.record({ kind: "reply", message_id: messageId, text });
  }

  async create(chatId, text) {
    this.record({ kind: "create", chat_id: chatId, text });
  }

  async sendCard(chatId, card) {
    const messageId = `card_${this.outgoing.length + 1}`;
    this.record({ kind: "card", chat_id: chatId, message_id: messageId, card });
    return messageId;
  }

  async patchCard(messageId, card) {
    this.record({ kind: "patch", message_id: messageId, card });
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
    this.interactions = new Map(); // chatId -> pending interaction (question batch or approval)
    this.disposeUserProvider = null;
  }

  async start() {
    this.loadState();
    this.transport = this.config.transport === "mock"
      ? new MockTransport({ port: this.config.mockPort, outgoingFile: this.config.mockOutgoingFile, logger: this.logger })
      : new LarkTransport({ appId: this.config.appId, appSecret: this.config.appSecret, logger: this.logger });
    await this.transport.start((data) => this.handleIncoming(data), (data) => this.handleCardAction(data));
    const configured = this.config.botOpenId || "";
    const fetched = configured === "" ? await this.transport.fetchBotOpenId() : undefined;
    const persisted = this.state.botOpenId || "";
    const next = configured || fetched || persisted || "";
    if (next !== this.state.botOpenId) {
      this.state.botOpenId = next;
      this.saveState();
    }
    await this.registerInteractions();
    this.logger.info(`[lark-bridge] started transport=${this.config.transport} workspace=${this.config.workspace} uploads=${this.config.uploadsDir} state=${this.config.stateFile} interactions=${this.config.interactionEnabled}`);
  }

  /**
   * v3.0: register the user-questions provider and the approval answerer so
   * agent-side asks (ask_user_question, plan review) and tool approvals are
   * forwarded to the matching Feishu chat instead of stalling the turn.
   */
  async registerInteractions() {
    if (!this.config.interactionEnabled) {
      this.logger.info("[lark-bridge] interactions disabled by config");
      return;
    }
    // The service rows may still be mounting when this plugin's start() runs;
    // wait briefly for them instead of giving up on first read.
    await this.ctx.get("loader")?.await();
    let userQuestions = this.ctx.get("userQuestions");
    let approval = this.ctx.get("approval");
    for (let attempt = 0; attempt < 20 && (userQuestions === void 0 || approval === void 0); attempt += 1) {
      if (userQuestions === void 0) userQuestions = this.ctx.get("userQuestions");
      if (approval === void 0) approval = this.ctx.get("approval");
      if (userQuestions === void 0 || approval === void 0) await new Promise((r) => setTimeout(r, 500));
    }
    if (userQuestions !== void 0) {
      this.disposeUserProvider = userQuestions.registerProvider({
        ask: (request) => this.askUser(request)
      });
      this.logger.info("[lark-bridge] user-questions provider registered");
    } else {
      this.logger.warn("[lark-bridge] userQuestions service not mounted; ask_user_question will not reach Feishu");
    }
    if (approval !== void 0) {
      this.ctx.on("approval/request", (req, next) => this.approveRequest(req, next));
      this.logger.info("[lark-bridge] approval answerer registered");
    } else {
      this.logger.warn("[lark-bridge] approval service not mounted; tool approvals will fail closed");
    }
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
      this.logger.warn(`[lark-bridge] could not read state file ${file}: ${errorMessage(error)}`);
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
      this.logger.warn(`[lark-bridge] could not write state file ${file}: ${errorMessage(error)}`);
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
      this.logger.warn(`[lark-bridge] reply to ${chatId} failed: ${errorMessage(error)}`);
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

    if (message.message_type === "text") {
      const text = textOfMessage(message);
      if (text === "") return;
      if (text.startsWith("/")) {
        await this.handleCommand(chatId, messageId, sender, text);
        return;
      }
      // v3.0: a pending question/approval consumes the next message as its answer.
      if (this.interactions.has(chatId)) {
        await this.answerInteraction(chatId, messageId, text);
        return;
      }
      await this.enqueue(chatId, messageId, { blocks: [{ type: "text", text }], logText: text });
      return;
    }
    await this.handleNonText(chatId, messageId, message);
  }

  async handleNonText(chatId, messageId, message) {
    const kind = message.message_type;
    if (kind === "post") {
      const text = textOfPost(message.content);
      if (text !== "") {
        await this.enqueue(chatId, messageId, { blocks: [{ type: "text", text }], logText: `📝 ${text.slice(0, 60)}` });
        return;
      }
      await this.safeReply(chatId, messageId, "📝 这条富文本消息没有可读文字内容。");
      return;
    }
    if (kind === "sticker") {
      await this.safeReply(chatId, messageId, "😀 暂不支持表情包消息，请直接发送文字、图片或文件。");
      return;
    }
    if (kind !== "image" && kind !== "file" && kind !== "media") {
      await this.safeReply(chatId, messageId, `📭 暂不支持消息类型「${kind}」，请发送文字、图片、视频/音频或文件。`);
      return;
    }
    await this.handleResourceMessage(chatId, messageId, message);
  }

  /** Map a live agent (or its session id) to the owning chat, if the bridge owns it. */
  chatIdForAgent(agent) {
    const sessionId = agent?.session?.id ?? agent?.id;
    if (sessionId === void 0) return void 0;
    return this.chatBySession.get(String(sessionId));
  }

  /** UserQuestions provider: forward an ask_user_question / plan-review batch to Feishu. */
  askUser(request) {
    const chatId = this.chatIdForAgent(request.agent);
    if (chatId === void 0) {
      return Promise.reject(new UserQuestionError("lark-bridge: cannot route question — no Feishu chat for this session", "ASK_MISSING_AGENT"));
    }
    return new Promise((resolve, reject) => {
      const pending = {
        kind: "question",
        questions: request.questions,
        resolve,
        reject,
        signal: request.signal
      };
      const onAbort = () => {
        if (this.interactions.get(chatId) === pending) this.interactions.delete(chatId);
        reject(new UserQuestionError("ask_user_question was aborted before the user answered", "ASK_ABORTED"));
      };
      pending.onAbort = onAbort;
      request.signal?.addEventListener("abort", onAbort, { once: true });
      pending.timer = this.armInteractionTimeout(chatId, pending, "question");
      this.interactions.set(chatId, pending);
      this.logger.info(`[lark-bridge] asking ${chatId}: ${request.questions.map((q) => q.question).join(" / ")}`);
      // v3.1: render as an interactive card with option buttons when possible;
      // any send failure falls back to the plain-text prompt.
      const useCard = this.config.cardMode && isButtonCompatible(request.questions);
      const card = useCard ? questionCard(request.questions, chatId) : void 0;
      const deliver = async () => {
        if (!useCard) return this.transport.create(chatId, formatQuestions(request.questions));
        try {
          pending.cardMessageId = await this.transport.sendCard(chatId, card);
          pending.card = card;
        } catch (error) {
          this.logger.warn(`[lark-bridge] card send failed (${errorMessage(error)}); falling back to text question`);
          await this.transport.create(chatId, formatQuestions(request.questions));
        }
      };
      void deliver().catch((error) => {
        if (this.interactions.get(chatId) === pending) {
          this.interactions.delete(chatId);
          if (pending.timer !== void 0) clearTimeout(pending.timer);
          request.signal?.removeEventListener("abort", onAbort);
        }
        reject(new UserQuestionError(`lark-bridge: failed to send question to Feishu (${errorMessage(error)})`, "ASK_SEND_FAILED"));
      });
    });
  }

  /** Approval answerer: forward a tool-approval request to Feishu. */
  approveRequest(req, next) {
    const chatId = this.chatIdForAgent(req.agent);
    if (chatId === void 0 || !this.chats.has(chatId)) return next();
    if (req.signal?.aborted === true) return Promise.resolve("cancelled");
    return new Promise((resolve) => {
      const pending = {
        kind: "approval",
        toolName: req.toolName,
        reason: req.reason,
        resolve,
        signal: req.signal
      };
      const onAbort = () => {
        if (this.interactions.get(chatId) === pending) this.interactions.delete(chatId);
        resolve("cancelled");
      };
      pending.onAbort = onAbort;
      req.signal?.addEventListener("abort", onAbort, { once: true });
      pending.timer = this.armInteractionTimeout(chatId, pending, "approval");
      this.interactions.set(chatId, pending);
      this.logger.info(`[lark-bridge] approval requested for ${chatId}: ${req.toolName}`);
      const card = this.config.cardMode ? approvalCard(chatId, req.toolName, req.reason) : void 0;
      const deliver = async () => {
        if (!this.config.cardMode) return this.transport.create(chatId, formatApproval({ toolName: req.toolName, reason: req.reason }));
        try {
          pending.cardMessageId = await this.transport.sendCard(chatId, card);
          pending.card = card;
        } catch (error) {
          this.logger.warn(`[lark-bridge] approval card send failed (${errorMessage(error)}); falling back to text`);
          await this.transport.create(chatId, formatApproval({ toolName: req.toolName, reason: req.reason }));
        }
      };
      void deliver().catch((error) => {
        if (this.interactions.get(chatId) === pending) {
          this.interactions.delete(chatId);
          if (pending.timer !== void 0) clearTimeout(pending.timer);
          req.signal?.removeEventListener("abort", onAbort);
        }
        this.logger.warn(`[lark-bridge] failed to send approval to ${chatId}: ${errorMessage(error)}`);
        resolve("unavailable");
      });
    });
  }

  /** Arm the configurable interaction timeout; returns the timer id. */
  armInteractionTimeout(chatId, pending, kind) {
    const timeoutMs = this.config.interactionTimeoutMs;
    if (!(timeoutMs > 0)) return void 0;
    return setTimeout(() => {
      if (this.interactions.get(chatId) !== pending) return;
      this.interactions.delete(chatId);
      pending.signal?.removeEventListener("abort", pending.onAbort);
      this.logger.warn(`[lark-bridge] interaction timed out for ${chatId} (${kind})`);
      if (kind === "approval") pending.resolve("cancelled");
      else pending.reject(new UserQuestionError("ask_user_question timed out before the user answered", "ASK_ABORTED"));
      void this.transport.create(chatId, `⏰ 等待你的回复超时，该${kind === "approval" ? "审批" : "问题"}已取消。如需继续请重新发起。`).catch(() => {});
    }, timeoutMs);
  }

  /** Remove a pending interaction, disarm its abort/timer, return it. */
  claimInteraction(chatId, pending) {
    this.interactions.delete(chatId);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    if (pending.timer !== void 0) clearTimeout(pending.timer);
  }

  /** Replace the interaction's card with an answered summary (best effort). */
  async patchAnsweredCard(pending, card) {
    if (pending.cardMessageId === void 0 || card === void 0) return;
    try {
      await this.transport.patchCard(pending.cardMessageId, card);
    } catch (error) {
      this.logger.warn(`[lark-bridge] card patch failed: ${errorMessage(error)}`);
    }
  }

  /**
   * v3.1: handle a Feishu card.action.trigger callback. The button `value`
   * carries `{ a: "answer"|"approval", c: chatId, ... }`; returns the card
   * callback response (toast), and on success patches the card to answered.
   */
  async handleCardAction(data) {
    const value = data?.action?.value;
    const chatId = typeof value?.c === "string" && value.c !== ""
      ? value.c
      : data?.context?.open_chat_id ?? data?.open_chat_id;
    if (chatId === void 0) return { toast: { type: "error", content: "无法定位会话" } };
    const pending = this.interactions.get(chatId);
    if (pending === void 0) return { toast: { type: "error", content: "该选择已失效，请忽略" } };
    if (value?.a === "approval") {
      const approved = value.d === "allow";
      this.claimInteraction(chatId, pending);
      const outcome = approved ? "allowed-once" : "rejected";
      this.logger.info(`[lark-bridge] approval answered via card for ${chatId} (${pending.toolName}): ${outcome}`);
      await this.patchAnsweredCard(pending, answeredApprovalCard(pending.card, approved));
      pending.resolve(outcome);
      return { toast: { type: "success", content: approved ? "已批准，继续执行" : "已拒绝" } };
    }
    if (value?.a === "answer") {
      const question = pending.questions.find((q) => String(q.id) === String(value.q));
      const optionIndex = Number(value.o);
      if (question === void 0 || !Number.isInteger(optionIndex)) {
        return { toast: { type: "error", content: "无效的选项" } };
      }
      const option = (question.options ?? [])[optionIndex];
      if (option === void 0) return { toast: { type: "error", content: "无效的选项" } };
      this.claimInteraction(chatId, pending);
      const answers = pending.questions.map((q) => {
        if (String(q.id) === String(value.q)) return { id: q.id, selected: [option.label] };
        return { id: q.id, selected: [] };
      });
      this.logger.info(`[lark-bridge] question answered via card for ${chatId}: ${JSON.stringify(answers)}`);
      const summary = pending.questions.map((q, i) => {
        const chosen = String(q.id) === String(value.q) ? option.label : "（未选择）";
        return `${i + 1}. ${q.question} → **${chosen}**`;
      }).join("\n");
      await this.patchAnsweredCard(pending, answeredQuestionCard(pending.card, summary));
      pending.resolve({ answers });
      return { toast: { type: "success", content: `已选择：${option.label}` } };
    }
    return { toast: { type: "error", content: "无法识别的卡片操作" } };
  }

  /** Consume the next Feishu message as the answer to the pending interaction. */
  async answerInteraction(chatId, messageId, text) {
    const pending = this.interactions.get(chatId);
    if (pending === void 0) return;
    this.claimInteraction(chatId, pending);
    if (pending.kind === "approval") {
      const outcome = parseApprovalOutcome(text);
      this.logger.info(`[lark-bridge] approval answered for ${chatId} (${pending.toolName}): ${outcome}`);
      if (pending.cardMessageId !== void 0 && pending.card !== void 0) {
        await this.patchAnsweredCard(pending, answeredApprovalCard(pending.card, outcome === "allowed-once"));
      }
      await this.safeReply(chatId, messageId, outcome === "allowed-once" ? "✅ 已批准，继续执行。" : "🚫 已拒绝。");
      pending.resolve(outcome);
      return;
    }
    const answers = parseBatch(text, pending.questions).map((parsed, i) => ({
      id: pending.questions[i].id,
      ...parsed
    }));
    this.logger.info(`[lark-bridge] question answered for ${chatId}: ${JSON.stringify(answers)}`);
    const summary = pending.questions.map((q, i) => {
      const parsed = answers[i];
      const chosen = parsed.selected?.length ? parsed.selected.join("、") : parsed.custom ?? "（未选择）";
      return `${i + 1}. ${q.question} → **${chosen}**`;
    }).join("\n");
    if (pending.cardMessageId !== void 0 && pending.card !== void 0) {
      await this.patchAnsweredCard(pending, answeredQuestionCard(pending.card, summary));
    }
    await this.safeReply(chatId, messageId, "✅ 已收到回答，继续处理…");
    pending.resolve({ answers });
  }

  /** Cancel every pending interaction for a chat (e.g. /new resets the session). */
  cancelInteractionsFor(chatId) {
    const pending = this.interactions.get(chatId);
    if (pending === void 0) return;
    this.claimInteraction(chatId, pending);
    if (pending.kind === "approval") pending.resolve("cancelled");
    else pending.reject(new UserQuestionError("ask_user_question was aborted by a session reset", "ASK_ABORTED"));
  }

  /** Download, save, attach, and enqueue one image/file/media message. */
  async handleResourceMessage(chatId, messageId, message) {
    let resource;
    try {
      resource = await this.transport.downloadResource(message);
    } catch (error) {
      this.logger.warn(`[lark-bridge] resource download failed for ${message.message_id}: ${errorMessage(error)}`);
      await this.safeReply(chatId, messageId, `💾 下载附件失败：${errorMessage(error)}`);
      return;
    }
    if (!resource || resource.bytes.byteLength === 0) {
      await this.safeReply(chatId, messageId, "💾 附件内容为空，无法处理。");
      return;
    }
    if (resource.bytes.byteLength > this.config.maxUploadBytes) {
      await this.safeReply(chatId, messageId, `📦 附件过大（${formatBytes(resource.bytes.byteLength)}，上限 ${formatBytes(this.config.maxUploadBytes)}），无法处理。`);
      return;
    }

    const savedPath = await this.saveUpload(resource);
    const blocks = [];
    const lines = [
      `📎 收到${labelOfKind(message.message_type)}：${savedPath}`,
      `（原文件名：${resource.name ?? "未知"}，大小：${formatBytes(resource.bytes.byteLength)}）`
    ];
    if (message.message_type === "image") {
      const ref = await this.attachImageIfPossible(resource);
      if (ref) {
        blocks.push({ type: "image", attachment: ref });
        lines.push("（图片已附加给模型查看）");
      } else {
        lines.push("（当前模型不支持直接读图，agent 可用 read_image 等工具解读）");
      }
    }
    lines.push("");
    lines.push("请解读并处理以上内容，把结果回复给我。");
    const text = lines.join("\n");
    blocks.unshift({ type: "text", text });
    await this.enqueue(chatId, messageId, {
      blocks,
      logText: `📎 ${labelOfKind(message.message_type)}: ${resource.name ?? savedPath}`
    });
  }

  /** Save downloaded bytes under the uploads directory with a safe name. */
  async saveUpload(resource) {
    const uploadsDir = resolve(this.config.uploadsDir);
    await mkdirSync(uploadsDir, { recursive: true });
    const ext = extOf(resource.name, resource.mediaType);
    const base = safeFilename(resource.name, ext);
    let target = join(uploadsDir, base);
    if (existsSync(target)) {
      target = join(uploadsDir, `${base.slice(0, -ext.length || undefined) || base}-${randomUUID().slice(0, 8)}${ext}`);
    }
    writeFileSync(target, resource.bytes);
    this.logger.info(`[lark-bridge] saved upload ${target} (${resource.bytes.byteLength} bytes)`);
    return target;
  }

  /** Whether the current default model declares image input. */
  async modelSupportsImage() {
    try {
      const defaultModel = this.ctx.get("agentDefaultModel");
      const llm = this.ctx.get("llm");
      if (!defaultModel || !llm) return false;
      const selection = defaultModel.currentSelection();
      if (!selection?.provider || !selection.model) return false;
      const info = await llm.resolveModelInfo(selection.provider, selection.model);
      return info.inputModalities?.includes("image") ?? false;
    } catch (error) {
      this.logger.warn(`[lark-bridge] image capability check failed (${errorMessage(error)}); treating as no image input`);
      return false;
    }
  }

  /** Attach an image to the turn when the model is image-capable. */
  async attachImageIfPossible(resource) {
    if (this.config.imageMode === "file") return null;
    const mediaType = detectImageMediaType(resource.bytes, resource.name);
    if (mediaType === null) return null;
    const vision = await this.modelSupportsImage();
    if (!vision) {
      this.logger.info("[lark-bridge] current model has no image input; image saved to disk only");
      return null;
    }
    const attachments = this.ctx.get("attachments");
    if (!attachments) return null;
    try {
      const ref = await attachments.saveImage({ data: new Uint8Array(resource.bytes), mediaType, name: resource.name });
      this.logger.info(`[lark-bridge] attached image ${ref.attachmentId} (${mediaType}, ${ref.width}x${ref.height})`);
      return ref;
    } catch (error) {
      this.logger.warn(`[lark-bridge] image attach failed (${errorMessage(error)}); image saved to disk only`);
      return null;
    }
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
        await this.safeReply(chatId, messageId, `📊 状态\n· 会话: ${sessionId}\n· 模型: ${model}\n· 排队消息: ${queue}\n· 工作目录: ${this.config.workspace}\n· 上传目录: ${this.config.uploadsDir}`);
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

  async enqueue(chatId, messageId, item) {
    let chat = this.chats.get(chatId);
    if (!chat) {
      chat = { handle: null, busy: false, queue: [] };
      this.chats.set(chatId, chat);
    }
    chat.queue.push({ messageId, blocks: item.blocks, logText: item.logText });
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
          await this.safeReply(chatId, item.messageId, `💥 处理失败：${errorMessage(error)}`);
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
    const presets = this.ctx.get("agentPresets");
    const setup = async (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: void 0 });
      // Join the configured agent preset (standard brings ask_user_question
      // and the full coding-agent tool set), mirroring the web host.
      if (presets !== void 0 && this.config.agentPreset !== "") {
        try {
          await presets.mount(agentCtx, this.config.agentPreset);
        } catch (error) {
          this.logger.warn(`[lark-bridge] agent preset "${this.config.agentPreset}" mount failed (${errorMessage(error)}); continuing without it`);
        }
      }
      // Keep the Feishu channel instructions in every system prompt even when
      // the joined agent preset shadows the deployment persona.
      agentCtx.on("system-prompt/assemble", async (_assembly, _context, next) => {
        const assembled = await next();
        return {
          ...assembled,
          sections: [...assembled.sections, { name: "lark-bridge:channel", order: 100, text: CHANNEL_INSTRUCTIONS }]
        };
      });
    };
    const meta = this.config.agentPreset === ""
      ? { cwd: this.config.workspace }
      : { cwd: this.config.workspace, agentPreset: this.config.agentPreset };

    const savedSessionId = this.state.chats[chatId];
    if (savedSessionId) {
      try {
        const handle = await agents.resume({ resumeSessionId: SessionId(savedSessionId), agentOptions, setup });
        this.logger.info(`[lark-bridge] resumed session ${savedSessionId} for chat ${chatId}`);
        return handle;
      } catch (error) {
        this.logger.warn(`[lark-bridge] resume of ${savedSessionId} failed (${errorMessage(error)}); creating a fresh session`);
        delete this.state.chats[chatId];
        this.saveState();
      }
    }
    const sessionId = SessionId(`session-${randomUUID()}`);
    const handle = await agents.create({ sessionId, meta, agentOptions, setup });
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
    this.logger.info(`[lark-bridge] turn start for ${chatId} (${item.messageId}): ${String(item.logText ?? "").slice(0, 60)}`);

    await agent.whenIdle();
    const firstSeq = agent.session.seq;
    agent.followup(createUserMessage({
      content: item.blocks,
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
    this.cancelInteractionsFor(chatId);
    const chat = this.chats.get(chatId);
    if (chat?.handle) {
      try {
        await chat.handle.dispose();
      } catch (error) {
        this.logger.warn(`[lark-bridge] dispose of chat ${chatId} failed: ${errorMessage(error)}`);
      }
      this.chatBySession.delete(String(chat.handle.agent.session.id));
      chat.handle = null;
    }
    delete this.state.chats[chatId];
    this.saveState();
  }

  async dispose() {
    this.transport?.stop();
    this.disposeUserProvider?.();
    for (const pending of [...this.interactions.values()]) {
      pending.signal?.removeEventListener("abort", pending.onAbort);
      if (pending.timer !== void 0) clearTimeout(pending.timer);
      if (pending.kind === "approval") pending.resolve("cancelled");
      else pending.reject(new UserQuestionError("lark-bridge was disposed before the user answered", "ASK_ABORTED"));
    }
    this.interactions.clear();
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
  const uploadsDir = resolve(config.uploadsDir || join(workspace, UPLOAD_SUBDIR));
  mkdirSync(uploadsDir, { recursive: true });
  const bridge = new Bridge({
    ctx,
    config: {
      ...config,
      appId,
      appSecret,
      workspace,
      uploadsDir,
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
