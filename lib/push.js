// @dsh/lark-bridge — feishu_send tool (v3.2): lets the DSH agent proactively
// push text or a card to a Feishu chat, not just reply to the triggering
// message. The tool is registered per agent (in ensureChatAgent's setup), so
// only bridge-owned agents see it. The chat resolver maps an agent back to its
// owning chat for the default target.
//
// Zero DSH imports on purpose (matching answers.js / cards.js / streaming.js):
// this module returns a plain ToolDefinition-shaped object that `ctx.tools`
// accepts via register(); argument validation is done here defensively. That
// keeps the module unit-testable without a DSH runtime.

/** Shared output schema for feishu_send results (JSON Schema form). */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    message_id: { type: "string" },
    error: { type: "string" }
  },
  required: ["ok"]
};

/**
 * Create the feishu_send tool definition.
 * @param deps - { sendText(chatId, text), sendCard(chatId, card), chatForAgent(agent), logger }.
 * @returns A ToolDefinition-shaped object for ctx.tools.register().
 */
export function createPushTool(deps) {
  const { sendText, sendCard, chatForAgent, logger } = deps;
  const log = logger ?? { info() {}, warn() {}, error() {} };
  return {
    name: "feishu_send",
    description:
      "Proactively send a message or an interactive card to a Feishu chat (single chat or group). " +
      "Omit chatId to send to the chat you are currently talking in. Use text for a plain message, " +
      "or card (JSON object) for an interactive card. Returns { ok, message_id } on success.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        chatId: {
          type: "string",
          description: "Target Feishu chat_id; omit to send to the current conversation."
        },
        text: {
          type: "string",
          description: "Plain-text content to send (mutually exclusive with card)."
        },
        card: {
          type: "object",
          description: "Feishu interactive-card JSON to send (mutually exclusive with text)."
        }
      }
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const text = value.ok
          ? `✅ 已推送${value.message_id ? `（${value.message_id}）` : ""}`
          : `❌ 推送失败：${value.error ?? "未知错误"}`;
        return [{ type: "text", text }];
      }
    },
    async execute(args, exec) {
      const chatId = args.chatId || chatForAgent?.(exec.agent);
      if (!chatId) {
        return { ok: false, error: "无法确定目标会话（未提供 chatId 且当前 agent 不属于任何飞书会话）" };
      }
      const hasText = typeof args.text === "string" && args.text !== "";
      const hasCard = args.card !== undefined && args.card !== null && typeof args.card === "object";
      if (hasText === hasCard) {
        return { ok: false, error: "必须且只能提供 text 或 card 之一" };
      }
      try {
        const messageId = hasText ? await sendText(chatId, args.text) : await sendCard(chatId, args.card);
        log.info(`[lark-bridge] feishu_send → ${chatId} (${hasText ? "text" : "card"}): ${messageId ?? "?"}`);
        // Build a lossless-JSON-safe result: a transport may legitimately
        // return undefined (some SDK send calls don't surface an id), and DSH
        // rejects output values containing undefined fields.
        return messageId === undefined || messageId === null ? { ok: true } : { ok: true, message_id: messageId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`[lark-bridge] feishu_send to ${chatId} failed: ${message}`);
        return { ok: false, error: message };
      }
    }
  };
}
