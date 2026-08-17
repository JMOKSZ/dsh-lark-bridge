// @dsh/lark-bridge — streaming progress card for long DSH turns (v3.2).
//
// TurnReporter owns the live card shown while one Feishu chat's agent runs a
// turn: it sends the initial "processing" card, feeds session events into a
// render state, and PATCHes the card on a throttle so Feishu's rate limits are
// respected. On finish it seals the card green (or red on error). Card PATCH
// failures are retried with exponential backoff; repeated failures trip a
// breaker that degrades the reporter (callers fall back to plain text).
//
// No DSH imports — the transport (sendCard/patchCard) is injected, so the
// lifecycle is unit-testable in test/streaming-test.mjs.

import { sealedStreamingCard, streamingCard } from "./cards.js";

const MAX_BUFFER = 4000; // keep only this much reasoning/answer tail in memory
const PATCH_BACKOFF_BASE_MS = 200; // exponential backoff base for patch retries
const PATCH_BACKOFF_MAX_MS = 2000;
const BREAKER_THRESHOLD = 5; // consecutive patch failures that trip the breaker

/** Keep the tail of a growing buffer under a cap. */
function tail(text, cap) {
  const t = String(text ?? "");
  return t.length <= cap ? t : t.slice(t.length - cap);
}

/** Render one tool entry from a tool/call + tool/result pair. */
function toolFromCall(name, args, status, summary) {
  return { name, args, status, summary };
}

export class TurnReporter {
  constructor({ config, sendCard, patchCard, logger }) {
    const streaming = config?.streaming ?? {};
    this.sendCard = sendCard;
    this.patchCard = patchCard;
    this.logger = logger ?? { info() {}, warn() {}, error() {} };
    this.patchIntervalMs = Math.max(30, streaming.patchIntervalMs ?? 700);
    this.maxBodyChars = Math.max(100, streaming.maxBodyChars ?? 900);
    this.showReasoning = streaming.showReasoning ?? true;
    this.showToolCalls = streaming.showToolCalls ?? true;
    this.titleStreaming = streaming.cardTitleStreaming ?? "🤖 DSH 处理中…";
    this.titleDone = streaming.cardTitleDone ?? "🤖 DSH 处理完成";
    this.patchBackoffBaseMs = Math.max(10, streaming.patchBackoffBaseMs ?? PATCH_BACKOFF_BASE_MS);
    this.breakerThreshold = Math.max(1, streaming.breakerThreshold ?? BREAKER_THRESHOLD);

    this.cardMessageId = undefined;
    this.status = "🧠 正在思考…";
    this.reasoning = "";
    this.answer = "";
    this.stepCount = 0;
    this.tools = []; // [{ name, args, status: running|ok|error, summary }]
    this.callNames = new Map(); // callId -> { name, args }
    this.finished = false;
    this.degraded = false; // breaker tripped → callers fall back to text
    this.startedAt = Date.now();

    this.patchTimer = undefined;
    this.pendingPatch = false;
    this.consecutivePatchFailures = 0;
    this.patchQueue = Promise.resolve();
  }

  /** Send the initial "processing" card; stores its message id. */
  async begin({ replyToMessageId, chatId } = {}) {
    const card = this.buildCard(false);
    this.cardMessageId = await this.sendCard(chatId ?? "", card);
    return this.cardMessageId;
  }

  /** Feed one DSH session event; schedules a throttled card PATCH. */
  onEvent(event) {
    if (this.finished || this.degraded) return;
    let changed = false;
    switch (event.type) {
      case "turn/start":
        this.status = "🧠 开始处理…";
        changed = true;
        break;
      case "step/start":
        this.stepCount += 1;
        this.status = `🔄 第 ${this.stepCount} 步 · 思考中…`;
        changed = true;
        break;
      case "assistant/chunk": {
        const chunk = event.data?.chunk;
        if (!chunk) break;
        if (chunk.type === "reasoning-delta" && this.showReasoning) {
          this.reasoning = tail(this.reasoning + (chunk.text ?? ""), MAX_BUFFER);
          changed = true;
        } else if (chunk.type === "text-delta") {
          this.answer = tail(this.answer + (chunk.text ?? ""), MAX_BUFFER);
          changed = true;
        } else if (chunk.type === "tool-call-delta" && this.showToolCalls && chunk.name) {
          this.status = `🔧 正在调用 \`${chunk.name}\`…`;
          changed = true;
        }
        break;
      }
      case "assistant/message": {
        const blocks = event.data?.message?.content ?? [];
        const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
        if (text !== "") {
          this.answer = tail(text, MAX_BUFFER);
          changed = true;
        }
        if (this.showReasoning) {
          const thinking = blocks.filter((b) => b.type === "reasoning").map((b) => b.text ?? "").join("");
          if (thinking !== "") {
            this.reasoning = tail(thinking, MAX_BUFFER);
            changed = true;
          }
        }
        break;
      }
      case "tool/call":
        if (this.showToolCalls) {
          const args = stringifyArgs(event.data?.arguments ?? {});
          this.callNames.set(String(event.data?.callId ?? "?"), { name: event.data?.name ?? "?", args });
          this.status = `🔧 调用 \`${event.data?.name}\`…`;
          changed = true;
        }
        break;
      case "tool/result": {
        if (this.showToolCalls) {
          const message = event.data?.message;
          const block = message?.content?.[0];
          // Real DSH carries the call id on message.source.callId; some
          // transports only put it on the tool-result block.
          const callId = message?.source?.callId ?? block?.toolCallId ?? "?";
          const call = this.callNames.get(String(callId)) ?? { name: "?", args: "" };
          const ok = event.data?.error === undefined;
          const summary = summarizeResult(message?.content, ok);
          this.tools.push(toolFromCall(call.name, call.args, ok ? "ok" : "error", summary));
          this.status = `${ok ? "✅" : "❌"} 工具 \`${call.name}\` 完成`;
          changed = true;
        }
        break;
      }
      default:
        break;
    }
    if (changed) this.schedulePatch();
  }

  /** Final patch: seal the card with the outcome (green/red). */
  async finish(outcome) {
    this.finished = true;
    if (this.patchTimer !== undefined) {
      clearTimeout(this.patchTimer);
      this.patchTimer = undefined;
    }
    this.pendingPatch = false;
    const elapsedSec = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const card = this.buildCard(true, outcome, elapsedSec);
    if (this.cardMessageId === undefined) return;
    await this.enqueuePatch(card, true);
  }

  /** Render the current state into a card JSON (streaming or sealed). */
  buildCard(sealed, outcome, elapsedSec) {
    if (sealed) {
      const error = outcome?.error;
      return sealedStreamingCard({
        answer: this.answer,
        tools: this.tools,
        titleDone: this.titleDone,
        elapsedSec,
        outcomeChars: String(this.answer ?? "").length,
        showToolCalls: this.showToolCalls,
        maxBodyChars: this.maxBodyChars,
        error
      });
    }
    return streamingCard({
      status: this.status,
      reasoning: this.reasoning,
      answer: this.answer,
      tools: this.tools,
      titleStreaming: this.titleStreaming,
      showReasoning: this.showReasoning,
      showToolCalls: this.showToolCalls,
      maxBodyChars: this.maxBodyChars
    });
  }

  /** Throttle: coalesce bursts of events into one PATCH per interval. */
  schedulePatch() {
    if (this.pendingPatch) return;
    this.pendingPatch = true;
    this.patchTimer = setTimeout(() => {
      this.patchTimer = undefined;
      this.pendingPatch = false;
      if (this.finished || this.degraded || this.cardMessageId === undefined) return;
      void this.enqueuePatch(this.buildCard(false));
    }, this.patchIntervalMs);
  }

  /** Serialize PATCHes; retry with backoff; trip breaker on repeated failures. */
  enqueuePatch(card, isFinal) {
    this.patchQueue = this.patchQueue
      .then(() => this.dispatchWithBackoff(card, isFinal))
      .catch(() => { /* contained */ });
    return this.patchQueue;
  }

  async dispatchWithBackoff(card, isFinal) {
    let attempt = 0;
    for (;;) {
      try {
        await this.patchCard(this.cardMessageId, card);
        this.consecutivePatchFailures = 0;
        return;
      } catch (error) {
        attempt += 1;
        this.consecutivePatchFailures += 1;
        if (this.consecutivePatchFailures >= this.breakerThreshold) {
          this.degraded = true;
          this.logger.warn(`[lark-bridge] streaming card breaker tripped after ${this.breakerThreshold} patch failures; falling back to text`);
          return;
        }
        if (isFinal && attempt >= 3) {
          this.logger.warn(`[lark-bridge] final card patch failed after ${attempt} attempts: ${errorMessage(error)}`);
          return;
        }
        const delay = Math.min(this.patchBackoffBaseMs * 2 ** Math.min(attempt - 1, 4), PATCH_BACKOFF_MAX_MS);
        await sleep(delay);
      }
    }
  }

  dispose() {
    this.finished = true;
    if (this.patchTimer !== undefined) {
      clearTimeout(this.patchTimer);
      this.patchTimer = undefined;
    }
    this.pendingPatch = false;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Compact args for the panel line (JSON, truncated). */
function stringifyArgs(args) {
  try {
    const s = JSON.stringify(args);
    return s && s !== "{}" ? s.slice(0, 160) : "";
  } catch {
    return "";
  }
}

/** One-line summary of a tool/result content array (recursively unwraps
 * tool-result blocks — real DSH nests the text inside them). */
function summarizeResult(content, ok) {
  const parts = [];
  const walk = (blocks) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      else if (block.type === "image") parts.push("[图片]");
      else if (Array.isArray(block.content)) walk(block.content);
    }
  };
  walk(content);
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text.slice(0, 200);
}

// Re-export the pure builders so callers can reuse them consistently.
export { sealedStreamingCard, streamingCard, toolPanelLines, toolLine } from "./cards.js";
