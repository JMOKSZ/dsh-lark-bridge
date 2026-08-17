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

// ---------------------------------------------------------------------------
// v3.2 streaming cards — pure builders for the live progress card shown while
// a DSH turn runs. No DSH imports; unit-tested in test/streaming-test.mjs.
// ---------------------------------------------------------------------------

/** Truncate a section of card body text to the per-card budget. */
function clip(text, max) {
  const t = String(text ?? "").replace(/\|/g, "\\|").trim();
  if (max <= 0 || t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/** One tool line for the tools panel: status icon · name · args · summary. */
export function toolLine(tool) {
  const icon = tool.status === "ok" ? "✅" : tool.status === "error" ? "❌" : "🔧";
  const name = String(tool.name ?? "工具");
  const args = String(tool.args ?? "").replace(/\n/g, " ").slice(0, 80);
  const summary = tool.summary ? ` · ${String(tool.summary).replace(/\n/g, " ").slice(0, 120)}` : "";
  return `${icon} <b>${name}</b>${args !== "" ? ` · \`${args}\`` : ""}${summary}`;
}

/** Render the tools panel as lark_md lines (empty when disabled or no tools). */
export function toolPanelLines(tools, showToolCalls) {
  if (!showToolCalls || !Array.isArray(tools) || tools.length === 0) return [];
  return tools.map(toolLine);
}

/**
 * Build the live streaming card for an in-flight turn.
 * @param state - { status, reasoning, answer, tools, titleStreaming,
 *   showReasoning, showToolCalls, maxBodyChars }.
 * @returns Feishu interactive-card JSON with native streaming_mode.
 */
export function streamingCard(state) {
  const {
    status = "🧠 正在思考…",
    reasoning = "",
    answer = "",
    tools = [],
    titleStreaming = "🤖 DSH 处理中…",
    showReasoning = true,
    showToolCalls = true,
    maxBodyChars = 900
  } = state;
  const elements = [];
  elements.push({ tag: "div", text: { tag: "lark_md", content: `**状态：** ${clip(status, 200)}` } });
  const reasoningText = clip(reasoning, maxBodyChars);
  if (showReasoning && reasoningText !== "") {
    elements.push({ tag: "hr" });
    elements.push({ tag: "div", text: { tag: "lark_md", content: `**思考：** ${reasoningText}` } });
  }
  const answerText = clip(answer, maxBodyChars);
  if (answerText !== "") {
    elements.push({ tag: "hr" });
    elements.push({ tag: "div", text: { tag: "lark_md", content: `**回答草稿：** ${answerText}` } });
  }
  const panel = toolPanelLines(tools, showToolCalls);
  if (panel.length > 0) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "div", text: { tag: "lark_md", content: `**工具调用：**\n${panel.join("\n")}` } });
  }
  elements.push({ tag: "note", elements: [{ tag: "plain_text", content: "正在实时更新…" }] });
  return {
    config: { wide_screen_mode: true, streaming_mode: true },
    header: { template: "blue", title: { tag: "plain_text", content: titleStreaming } },
    elements
  };
}

/**
 * Build the sealed (terminal) card shown when the turn finishes.
 * @param state - { answer, tools, titleDone, elapsedSec, outcomeChars,
 *   showToolCalls, maxBodyChars, error? }.
 * @returns green (success) or red (error) card JSON.
 */
export function sealedStreamingCard(state) {
  const {
    answer = "",
    tools = [],
    titleDone = "🤖 DSH 处理完成",
    elapsedSec = "",
    outcomeChars = 0,
    showToolCalls = true,
    maxBodyChars = 900,
    error
  } = state;
  const failed = Boolean(error);
  const elements = [];
  if (failed) {
    elements.push({ tag: "div", text: { tag: "lark_md", content: `**😵 处理失败：** ${clip(error, maxBodyChars)}` } });
  } else {
    const answerText = clip(answer, maxBodyChars);
    elements.push({ tag: "div", text: { tag: "lark_md", content: answerText !== "" ? answerText : "✅ 完成（没有文本输出）。" } });
  }
  const panel = toolPanelLines(tools, showToolCalls);
  if (panel.length > 0) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "div", text: { tag: "lark_md", content: `**工具调用：**\n${panel.join("\n")}` } });
  }
  const noteParts = [];
  if (elapsedSec !== "") noteParts.push(`用时 ${elapsedSec}s`);
  if (!failed) noteParts.push(`输出 ${outcomeChars} 字`);
  if (noteParts.length > 0) {
    elements.push({ tag: "note", elements: [{ tag: "plain_text", content: `✅ ${noteParts.join(" · ")}` }] });
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: failed ? "red" : "green", title: { tag: "plain_text", content: failed ? "😵 DSH 处理失败" : titleDone } },
    elements
  };
}
