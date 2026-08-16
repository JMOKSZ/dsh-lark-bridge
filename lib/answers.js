// Pure helpers for v3.0 interactive flows: rendering Feishu prompts and
// parsing Feishu replies into DSH answer shapes. No DSH imports here so the
// module is unit-testable and dependency-free.

/** Render one ask_user_question batch as a Feishu text message. */
export function formatQuestions(questions) {
  const blocks = [];
  for (const [index, q] of questions.entries()) {
    const lines = [];
    if (q.header) lines.push(`【${q.header}】`);
    lines.push(`❓ ${q.question}`);
    if (q.detail) lines.push(q.detail);
    const options = q.options ?? [];
    if (options.length > 0) {
      lines.push("");
      lines.push("选项：");
      options.forEach((option, j) => {
        lines.push(`${j + 1}. ${option.label}${option.description ? `（${option.description}）` : ""}`);
      });
    }
    lines.push("");
    if (questions.length > 1) {
      lines.push(q.multiSelect
        ? "回复方式：输入「编号.回答」（一行一题，如 1. 内容；2. 内容）"
        : options.length > 0
          ? "回复方式：输入「编号.选项序号或文字」，或按题用 / 分隔编号（如 2/3/1），或直接输入自定义内容"
          : "回复方式：输入「编号.你的回答」");
      lines.push(`（第 ${index + 1}/${questions.length} 题）`);
    } else if (q.multiSelect) {
      lines.push("回复方式：输入选项编号（可多个，逗号分隔），或直接输入自定义内容");
    } else if (options.length > 0) {
      lines.push("回复方式：输入选项编号或选项文字，或直接输入自定义内容");
    } else {
      lines.push("回复方式：直接输入你的回答");
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n────────\n\n");
}

/** Render one tool-approval request as a Feishu text message. */
export function formatApproval({ toolName, reason }) {
  const lines = ["🔐 需要你审批", `工具：${toolName}`];
  if (reason) lines.push(`原因：${reason}`);
  lines.push("");
  lines.push("回复「1 / 批准 / 允许」继续，或「2 / 拒绝」中止。");
  return lines.join("\n");
}

const ALLOW_WORDS = ["1", "批准", "允许", "同意", "确认", "继续", "是", "好", "ok", "yes", "y", "approve", "allow"];
const REJECT_WORDS = ["2", "拒绝", "驳回", "不同意", "取消", "停止", "否", "不", "no", "n", "reject", "deny"];

/** Map a Feishu reply to an approval outcome; unknown input fails closed. */
export function parseApprovalOutcome(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (ALLOW_WORDS.includes(t)) return "allowed-once";
  if (REJECT_WORDS.includes(t)) return "rejected";
  if (ALLOW_WORDS.some((w) => w.length > 1 && t.includes(w))) return "allowed-once";
  if (REJECT_WORDS.some((w) => w.length > 1 && t.includes(w))) return "rejected";
  return "rejected";
}

/**
 * Parse one question's answer from a Feishu reply.
 * Returns `{ selected: string[], custom?: string }` — `selected` is always an
 * array (the tool consumer spreads it); `custom` overrides selection for
 * free-form input (single-select contract: selected stays empty).
 */
export function parseQuestionAnswer(question, text) {
  const options = question.options ?? [];
  const raw = String(text ?? "").trim();
  const labelAt = (n) => (n >= 0 && n < options.length ? options[n].label : undefined);

  if (question.multiSelect) {
    const parts = raw.split(/[,，、;；\s]+/).filter(Boolean);
    const selected = [];
    const custom = [];
    for (const part of parts) {
      const n = /^\d+$/.test(part) ? Number(part) - 1 : -1;
      const label = labelAt(n);
      if (label !== undefined && !selected.includes(label)) selected.push(label);
      else if (!/^\d+$/.test(part)) custom.push(part);
    }
    const joined = custom.join("，");
    return joined !== "" ? { selected, custom: joined } : { selected };
  }

  if (options.length > 0) {
    const n = /^\d+$/.test(raw) ? Number(raw) - 1 : -1;
    const label = labelAt(n);
    if (label !== undefined) return { selected: [label] };
    const byLabel = options.find((o) => o.label === raw || (raw !== "" && raw.includes(o.label)));
    if (byLabel !== undefined) return { selected: [byLabel.label] };
  }
  if (raw !== "") return { selected: [], custom: raw };
  return { selected: [] };
}

/**
 * Parse a batch reply covering several questions. Supports:
 * - `编号.回答` per line (or `;` / `；` separated),
 * - a bare slash list whose length matches the question count, interpreted
 *   positionally (e.g. `2/3/3` answers questions 1-3 with options 2, 3, 3).
 * Unmarked questions fall back to the whole text.
 */
export function parseBatch(text, questions) {
  if (questions.length === 1) return [parseQuestionAnswer(questions[0], text)];
  const results = new Array(questions.length).fill(null);
  let parts = String(text ?? "")
    .split(/\n+/)
    .flatMap((line) => line.split(/[;；]/))
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 1) {
    const slashed = parts[0].split(/\s*[\/|]\s*/).filter(Boolean);
    if (slashed.length === questions.length) parts = slashed;
  }
  const positional = parts.length === questions.length && parts.every((p) => /^\d+$/.test(p));
  for (const [index, part] of parts.entries()) {
    const match = part.match(/^(?:q)?(\d+)\s*[:：.=、]\s*([\s\S]*)$/i);
    if (match !== null) {
      const idx = Number(match[1]) - 1;
      if (idx >= 0 && idx < questions.length) results[idx] = parseQuestionAnswer(questions[idx], match[2]);
    } else if (positional && /^\d+$/.test(part)) {
      results[index] = parseQuestionAnswer(questions[index], part);
    }
  }
  return questions.map((q, i) => results[i] ?? parseQuestionAnswer(q, text));
}
