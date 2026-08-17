// streaming-test.mjs — unit tests for the v3.2 streaming-card layer.
//
// Tests the pure card builders in lib/cards.js (streamingCard / toolPanel),
// the TurnReporter lifecycle in lib/streaming.js with a fake transport
// (event→state transitions, throttled PATCH scheduling, failure backoff/
// breaker, sealed/error terminal states), and the feishu_send push tool in
// lib/push.js.
//
// Usage:  node test/streaming-test.mjs

import { streamingCard, toolPanelLines, sealedStreamingCard } from "../lib/cards.js";
import { TurnReporter } from "../lib/streaming.js";
import { createPushTool } from "../lib/push.js";

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
}
function fail(label, detail) {
  check(label, false, detail);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Pure card builders (Task 1)
// ---------------------------------------------------------------------------

function mdText(card, elementIndex) {
  return card?.elements?.[elementIndex]?.text?.content ?? "";
}

{
  // streamingCard renders the streaming mode flag, header, status and notes.
  const card = streamingCard({
    status: "🧠 正在思考…",
    reasoning: "",
    answer: "",
    tools: [],
    titleStreaming: "🤖 DSH 处理中…",
    showReasoning: true,
    showToolCalls: true,
    maxBodyChars: 900
  });
  check("streamingCard sets streaming_mode", card?.config?.streaming_mode === true, JSON.stringify(card?.config));
  check("streamingCard header title", card?.header?.title?.content === "🤖 DSH 处理中…", card?.header?.title?.content);
  check("streamingCard shows status", mdText(card, 0).includes("🧠 正在思考…"), mdText(card, 0).slice(0, 60));
}

{
  // Reasoning and answer sections appear when non-empty; hidden when empty.
  const card = streamingCard({
    status: "🔄 第 1 步 · 思考中…",
    reasoning: "用户想分析测试覆盖率",
    answer: "正在运行测试…",
    tools: [],
    titleStreaming: "🤖 DSH 处理中…",
    showReasoning: true,
    showToolCalls: true,
    maxBodyChars: 900
  });
  const body = card.elements.map((e) => e.text?.content ?? "").join("\n");
  check("streamingCard includes reasoning", body.includes("用户想分析测试覆盖率"), "");
  check("streamingCard includes answer draft", body.includes("正在运行测试…"), "");
}

{
  // showReasoning:false hides the reasoning section even when present.
  const card = streamingCard({
    status: "…",
    reasoning: "秘密思考",
    answer: "",
    tools: [],
    titleStreaming: "T",
    showReasoning: false,
    showToolCalls: true,
    maxBodyChars: 900
  });
  const body = card.elements.map((e) => e.text?.content ?? "").join("\n");
  check("streamingCard hides reasoning when disabled", !body.includes("秘密思考"), "");
}

{
  // toolPanelLines renders per-tool status lines with name and summary.
  const lines = toolPanelLines([
    { name: "bash", args: "ls -la", status: "running" },
    { name: "read_image", args: "/tmp/x.png", status: "ok", summary: "640x480" },
    { name: "bash", args: "npm test", status: "error", summary: "exit 1" }
  ], true);
  const joined = lines.join("\n");
  check("toolPanelLines running icon", joined.includes("🔧"), joined.slice(0, 80));
  check("toolPanelLines ok icon", joined.includes("✅"), "");
  check("toolPanelLines error icon", joined.includes("❌"), "");
  check("toolPanelLines tool name", joined.includes("<b>bash</b>"), "");
  check("toolPanelLines error summary", joined.includes("exit 1"), "");
}

{
  // sealedStreamingCard: green header, final answer, no status line.
  const card = sealedStreamingCard({
    answer: "最终回复：测试全部通过。",
    tools: [{ name: "bash", args: "npm test", status: "ok" }],
    titleDone: "🤖 DSH 处理完成",
    elapsedSec: "3.2",
    outcomeChars: 12,
    showToolCalls: true,
    maxBodyChars: 900,
    error: undefined
  });
  check("sealed header green", card?.header?.template === "green", card?.header?.template);
  check("sealed title", card?.header?.title?.content === "🤖 DSH 处理完成", card?.header?.title?.content);
  const body = card.elements.map((e) => e.text?.content ?? "").join("\n");
  check("sealed shows final answer", body.includes("最终回复：测试全部通过。"), "");
  check("sealed shows timing note", JSON.stringify(card).includes("3.2"), "");
}

{
  // Sealed error card: red header with the error message.
  const card = sealedStreamingCard({
    answer: "",
    tools: [],
    titleDone: "🤖 DSH 处理完成",
    elapsedSec: "1.0",
    outcomeChars: 0,
    showToolCalls: true,
    maxBodyChars: 900,
    error: "模型超时"
  });
  check("sealed error header red", card?.header?.template === "red", card?.header?.template);
  const body = card.elements.map((e) => e.text?.content ?? "").join("\n");
  check("sealed error message shown", body.includes("模型超时"), "");
}

// ---------------------------------------------------------------------------
// TurnReporter lifecycle (Task 2) — fake transport, fast patch interval
// ---------------------------------------------------------------------------

class FakeTransport {
  constructor() {
    this.cards = []; // { kind: "create"|"patch", card, failed? }
    this.failPatches = 0; // how many patch calls should throw
    this.patchFailures = 0;
  }
  async sendCard(chatId, card) {
    this.cards.push({ kind: "create", card });
    return `msg_${this.cards.length}`;
  }
  async patchCard(messageId, card) {
    this.patchFailures += 1;
    if (this.failPatches > 0) {
      this.failPatches -= 1;
      throw new Error("patch rate limited");
    }
    this.cards.push({ kind: "patch", messageId, card });
  }
}

function makeReporter(transport, overrides = {}) {
  const base = {
    streaming: {
      patchIntervalMs: 30,
      maxBodyChars: 900,
      showReasoning: true,
      showToolCalls: true,
      cardTitleStreaming: "🤖 DSH 处理中…",
      cardTitleDone: "🤖 DSH 处理完成"
    },
    push: { enabled: true }
  };
  const config = {
    ...base,
    ...(overrides.config ?? {}),
    streaming: { ...base.streaming, ...(overrides.config?.streaming ?? {}) }
  };
  return new TurnReporter({
    config,
    sendCard: (chatId, card) => transport.sendCard(chatId, card),
    patchCard: (messageId, card) => transport.patchCard(messageId, card),
    logger: { info() {}, warn() {}, error() {} }
  });
}

{
  // begin() creates the initial card.
  const transport = new FakeTransport();
  const reporter = makeReporter(transport);
  await reporter.begin({ replyToMessageId: "om_1" });
  check("begin creates a card", transport.cards.length === 1 && transport.cards[0].kind === "create", JSON.stringify(transport.cards[0]?.card?.header));
}

{
  // Event sequence drives state; throttled patches land on the transport.
  const transport = new FakeTransport();
  const reporter = makeReporter(transport);
  await reporter.begin({ replyToMessageId: "om_1" });
  reporter.onEvent({ type: "turn/start", seq: 1 });
  reporter.onEvent({ type: "step/start", seq: 2, data: { step: 1 } });
  reporter.onEvent({ type: "assistant/chunk", seq: 3, data: { chunk: { type: "reasoning-delta", text: "先看看目录" } } });
  reporter.onEvent({ type: "tool/call", seq: 4, data: { callId: "c1", name: "bash", arguments: { command: "ls" } } });
  reporter.onEvent({
    type: "tool/result",
    seq: 5,
    data: {
      message: {
        source: { callId: "c1" },
        content: [{ type: "tool-result", toolCallId: "c1", isError: false, content: [{ type: "text", text: "ok" }] }]
      }
    }
  });
  reporter.onEvent({ type: "assistant/chunk", seq: 6, data: { chunk: { type: "text-delta", text: "完成" } } });
  await sleep(120); // allow the throttle to flush
  const patches = transport.cards.filter((c) => c.kind === "patch");
  check("events produce at least one patch", patches.length >= 1, `patches=${patches.length}`);
  const last = patches[patches.length - 1]?.card;
  const body = last ? last.elements.map((e) => e.text?.content ?? "").join("\n") : "";
  check("patch carries reasoning", body.includes("先看看目录"), body.slice(0, 60));
  check("patch carries tool line", body.includes("bash"), body.slice(0, 60));
  reporter.dispose();
}

{
  // finish() seals the card with the final answer.
  const transport = new FakeTransport();
  const reporter = makeReporter(transport);
  await reporter.begin({ replyToMessageId: "om_1" });
  reporter.onEvent({ type: "turn/start", seq: 1 });
  reporter.onEvent({ type: "assistant/message", seq: 2, data: { message: { content: [{ type: "text", text: "全部测试通过" }] } } });
  await reporter.finish({ text: "全部测试通过", error: undefined });
  await sleep(80);
  const patches = transport.cards.filter((c) => c.kind === "patch");
  const last = patches[patches.length - 1]?.card;
  check("finish patches to sealed card", last?.header?.template === "green", JSON.stringify(last?.header));
  check("sealed shows answer", JSON.stringify(last).includes("全部测试通过"), "");
  reporter.dispose();
}

{
  // finish() with error seals red and keeps the error text.
  const transport = new FakeTransport();
  const reporter = makeReporter(transport);
  await reporter.begin({ replyToMessageId: "om_1" });
  await reporter.finish({ text: "", error: "模型超时" });
  await sleep(80);
  const patches = transport.cards.filter((c) => c.kind === "patch");
  const last = patches[patches.length - 1]?.card;
  check("error finish seals red", last?.header?.template === "red", JSON.stringify(last?.header));
  check("error text in card", JSON.stringify(last).includes("模型超时"), "");
  reporter.dispose();
}

{
  // PATCH failures: exponential backoff retries, then success.
  const transport = new FakeTransport();
  transport.failPatches = 2; // first two patches fail
  const reporter = makeReporter(transport, { config: { streaming: { patchBackoffBaseMs: 10 } } });
  await reporter.begin({ replyToMessageId: "om_1" });
  reporter.onEvent({ type: "turn/start", seq: 1 });
  reporter.onEvent({ type: "assistant/chunk", seq: 2, data: { chunk: { type: "text-delta", text: "a" } } });
  await sleep(400); // longer than the backoff window
  check("patch failures retried (backoff)", transport.patchFailures >= 3, `attempts=${transport.patchFailures}`);
  const okPatches = transport.cards.filter((c) => c.kind === "patch" && !c.failed);
  check("eventual successful patch after backoff", okPatches.length >= 1, `ok=${okPatches.length}`);
  reporter.dispose();
}

{
  // Consecutive patch failures trip the breaker → reporter degrades.
  const transport = new FakeTransport();
  transport.failPatches = 100; // always fail
  const reporter = makeReporter(transport, { config: { streaming: { patchBackoffBaseMs: 10 } } });
  await reporter.begin({ replyToMessageId: "om_1" });
  for (let i = 0; i < 6; i += 1) {
    reporter.onEvent({ type: "assistant/chunk", seq: i + 1, data: { chunk: { type: "text-delta", text: `x${i}` } } });
  }
  await sleep(1500); // 5 backoff rounds at 10ms base
  check("breaker trips after repeated failures", reporter.degraded === true, `degraded=${reporter.degraded}`);
  reporter.dispose();
}

{
  // dispose() clears timers; no further patches after dispose.
  const transport = new FakeTransport();
  const reporter = makeReporter(transport);
  await reporter.begin({ replyToMessageId: "om_1" });
  reporter.onEvent({ type: "turn/start", seq: 1 });
  reporter.dispose();
  await sleep(120);
  const patches = transport.cards.filter((c) => c.kind === "patch");
  check("no patches after dispose", patches.length === 0, `patches=${patches.length}`);
}

// ---------------------------------------------------------------------------
// feishu_send push tool (Task 3)
// ---------------------------------------------------------------------------

function makePushDeps(overrides = {}) {
  const calls = [];
  const deps = {
    sendText: async (chatId, text) => {
      calls.push({ kind: "text", chatId, text });
      return `msg_text_${calls.length}`;
    },
    sendCard: async (chatId, card) => {
      calls.push({ kind: "card", chatId, card });
      return `msg_card_${calls.length}`;
    },
    chatForAgent: () => "oc_default",
    logger: { info() {}, warn() {}, error() {} },
    ...overrides
  };
  return { deps, calls };
}

{
  // feishu_send text to the default chat.
  const { deps, calls } = makePushDeps();
  const tool = createPushTool(deps);
  const result = await tool.execute({ text: "任务已完成" }, { agent: {} });
  check("push text returns ok", result.ok === true, JSON.stringify(result));
  check("push text to default chat", calls.length === 1 && calls[0].kind === "text" && calls[0].chatId === "oc_default", JSON.stringify(calls[0]));
  check("push text content", calls[0]?.text === "任务已完成", calls[0]?.text);
}

{
  // feishu_send card to an explicit chat.
  const { deps, calls } = makePushDeps();
  const tool = createPushTool(deps);
  const card = { config: {}, header: { title: { tag: "plain_text", content: "通知" } }, elements: [] };
  const result = await tool.execute({ chatId: "oc_other", card }, { agent: {} });
  check("push card returns ok", result.ok === true, JSON.stringify(result));
  check("push card to explicit chat", calls.length === 1 && calls[0].kind === "card" && calls[0].chatId === "oc_other", JSON.stringify(calls[0]));
  check("push card payload passed through", calls[0]?.card === card, "");
}

{
  // feishu_send without chatId and no resolvable chat → error.
  const { deps } = makePushDeps({ chatForAgent: () => undefined });
  const tool = createPushTool(deps);
  const result = await tool.execute({ text: "hi" }, { agent: {} });
  check("push without target fails", result.ok === false && /目标会话/.test(result.error ?? ""), JSON.stringify(result));
}

{
  // feishu_send with both text and card → error (mutually exclusive).
  const { deps, calls } = makePushDeps();
  const tool = createPushTool(deps);
  const result = await tool.execute({ text: "hi", card: { elements: [] } }, { agent: {} });
  check("push text+card rejected", result.ok === false && /之一/.test(result.error ?? ""), JSON.stringify(result));
  check("push rejected sends nothing", calls.length === 0, `calls=${calls.length}`);
}

{
  // feishu_send transport failure → error result, no throw.
  const { deps } = makePushDeps({
    sendText: async () => {
      throw new Error("rate limited");
    }
  });
  const tool = createPushTool(deps);
  const result = await tool.execute({ text: "hi" }, { agent: {} });
  check("push transport failure returns error", result.ok === false && /rate limited/.test(result.error ?? ""), JSON.stringify(result));
}

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
