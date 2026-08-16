// Feishu interactive-card builders (v3.1). Pure functions — no DSH imports —
// so they are unit-testable. Cards render interaction options as clickable
// buttons; the button `value` carries the routing payload returned to the
// bridge through the `card.action.trigger` callback.

const MAX_BUTTON_OPTIONS = 5;

/** True when a question batch can be rendered as one button card. */
export function isButtonCompatible(questions) {
  return questions.every((q) => !q.multiSelect && (q.options ?? []).length >= 1 && (q.options ?? []).length <= MAX_BUTTON_OPTIONS);
}

/** Markdown-safe question text (collapse newlines, escape pipes). */
function markdownText(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

/**
 * Build the card for an ask_user_question batch.
 * @param questions - the batch (must satisfy {@link isButtonCompatible}).
 * @param chatId - chat the card is sent to (embedded in button values).
 * @returns card JSON object.
 */
export function questionCard(questions, chatId) {
  const elements = [];
  for (const [index, q] of questions.entries()) {
    const lines = [];
    if (q.header) lines.push(`**${markdownText(q.header)}**`);
    lines.push(`${index + 1}. ${markdownText(q.question)}`);
    if (q.detail) lines.push(markdownText(q.detail));
    elements.push({ tag: "div", text: { tag: "lark_md", content: lines.join("\n") } });
    const options = q.options ?? [];
    elements.push({
      tag: "action",
      actions: options.map((option, j) => ({
        tag: "button",
        text: { tag: "plain_text", content: String(option.label).slice(0, 30) },
        type: j === 0 ? "primary" : "default",
        value: { a: "answer", c: chatId, q: String(q.id), o: String(j) }
      }))
    });
  }
  elements.push({
    tag: "note",
    elements: [{ tag: "plain_text", content: "点击选项即可；也可以直接回复编号或自定义内容。" }]
  });
  return {
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { tag: "plain_text", content: "❓ DSH 需要你选择" } },
    elements
  };
}

/**
 * Build the card for a tool-approval request.
 * @param chatId - chat the card is sent to.
 * @param toolName - the tool asking for approval.
 * @param reason - optional reason text.
 * @returns card JSON object.
 */
export function approvalCard(chatId, toolName, reason) {
  const lines = [`**工具：**${markdownText(toolName)}`];
  if (reason) lines.push(markdownText(reason));
  return {
    config: { wide_screen_mode: true },
    header: { template: "orange", title: { tag: "plain_text", content: "🔐 需要你审批" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "✅ 批准" }, type: "primary", value: { a: "approval", c: chatId, d: "allow" } },
          { tag: "button", text: { tag: "plain_text", content: "🚫 拒绝" }, type: "danger", value: { a: "approval", c: chatId, d: "reject" } }
        ]
      }
    ]
  };
}

/** Replace the buttons of a question card with an answered summary. */
export function answeredQuestionCard(card, summary) {
  return {
    ...card,
    header: { ...card.header, template: "green", title: { tag: "plain_text", content: "✅ 已收到你的选择" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: summary } },
      { tag: "note", elements: [{ tag: "plain_text", content: "DSH 已继续处理，无需其他操作。" }] }
    ]
  };
}

/** Replace the buttons of an approval card with the decision. */
export function answeredApprovalCard(card, approved) {
  return {
    ...card,
    header: { ...card.header, template: approved ? "green" : "red", title: { tag: "plain_text", content: approved ? "✅ 已批准" : "🚫 已拒绝" } },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: approved ? "操作已批准，继续执行。" : "操作已被拒绝，已中止。" } }
    ]
  };
}
