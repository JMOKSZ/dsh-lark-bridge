// mock-llm-server.mjs — a minimal OpenAI-compatible chat completions server
// used to verify the lark profile end to end without any real model access.
// Serves GET */models and POST */chat/completions (both streaming and
// non-streaming). The assistant reply echoes the last user message.

import http from "node:http";

const PORT = Number(process.env.MOCK_LLM_PORT ?? 4799);

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function sseData(res, value) {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    console.log(`[mock-llm] ${req.method} ${url.pathname}${req.method === "POST" ? ` stream=${String(body).includes('"stream":true')} body=${body.slice(0, 200)}` : ""}`);
    if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      const parsed0 = JSON.parse(body);
      const roles = (parsed0.messages ?? []).map((m) => m.role).join(",");
      const lastRole0 = [...(parsed0.messages ?? [])].reverse().find((m) => m.role === "user");
      console.log(`[mock-llm] roles=${roles} lastUserRoleContent=${JSON.stringify(lastRole0 ? lastRole0.content : null).slice(0, 120)} toolMsg=${JSON.stringify((parsed0.messages ?? []).find((m) => m.role === "tool") || null).slice(0, 320)}`);
    }
    if (req.method === "GET" && url.pathname.endsWith("/models")) {
      json(res, 200, { object: "list", data: [{ id: "mock-model", object: "model" }] });
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        json(res, 400, { error: { message: "bad json", type: "invalid_request_error" } });
        return;
      }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const extract = (m) => (Array.isArray(m?.content)
        ? m.content.filter((b) => b && b.type === "text").map((b) => String(b.text ?? "")).join(" ")
        : String(m?.content ?? ""));
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const userText = extract(lastUser);
      // The harness may inject instruction reminders as extra user messages;
      // search every user message for the task trigger.
      const allUserText = messages.filter((m) => m.role === "user").map(extract).join("\n");
      const text = `MOCK-REPLY: ${userText}`;
      const model = String(parsed.model ?? "mock-model");
      const id = `mock-chat-${Math.floor(Math.random() * 1e9)}`;
      const created = Math.floor(Date.now() / 1000);
      // v3.0 interaction trigger: the first turn after an "ASK_QUESTION" user
      // message returns a tool call to ask_user_question; the follow-up turn
      // (with tool results) returns the ordinary text reply.
      const wantsAsk = allUserText.includes("ASK_QUESTION") && !messages.some((m) => m.role === "tool");
      const wantMulti = allUserText.includes("ASK_QUESTION2");
      // v3.2 push trigger: the first turn after a "PUSH_IT" user message calls
      // feishu_send to prove the proactive push tool end to end.
      const wantsPush = allUserText.includes("PUSH_IT") && !messages.some((m) => m.role === "tool");
      const toolCall = wantsAsk ? [{
        id: "call_mock_ask",
        type: "function",
        function: {
          name: "ask_user_question",
          arguments: JSON.stringify({
            questions: wantMulti ? [{
              id: "q_mock2",
              header: "多选",
              question: "选哪些项？",
              options: [{ label: "x" }, { label: "y" }, { label: "z" }],
              multi_select: true
            }] : [{
              id: "q_mock",
              header: "选择方案",
              question: "你想选哪个方案？",
              options: [
                { label: "方案A", description: "快速稳定" },
                { label: "方案B", description: "全面但慢" }
              ]
            }]
          })
        }
      }] : wantsPush ? [{
        id: "call_mock_push",
        type: "function",
        function: {
          name: "feishu_send",
          arguments: JSON.stringify({ text: "🎉 任务完成，主动推送成功！" })
        }
      }] : undefined;
      if (parsed.stream === true) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        if (toolCall !== undefined) {
          // Stream the tool call in three chunks (start / arguments / finish).
          const nameChunk = {
            id, object: "chat.completion.chunk", created, model,
            choices: [{
              index: 0,
              delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: toolCall[0].id, type: "function", function: { name: toolCall[0].function.name, arguments: "" } }] },
              finish_reason: null
            }]
          };
          const argsChunk = {
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: toolCall[0].function.arguments } }] }, finish_reason: null }]
          };
          const doneChunk = {
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
          };
          let step = 0;
          const chunks = [nameChunk, argsChunk, doneChunk];
          const timer = setInterval(() => {
            if (step >= chunks.length) {
              clearInterval(timer);
              res.write("data: [DONE]\n\n");
              res.end();
              return;
            }
            sseData(res, chunks[step]);
            step += 1;
          }, 25);
          res.on("close", () => clearInterval(timer));
          return;
        }
        const pieces = [];
        for (let i = 0; i < text.length; i += 8) pieces.push(text.slice(i, i + 8));
        let i = 0;
        const timer = setInterval(() => {
          if (i >= pieces.length) {
            clearInterval(timer);
            sseData(res, {
              id, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
            });
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          sseData(res, {
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: { content: pieces[i] }, finish_reason: null }]
          });
          i += 1;
        }, 20);
        res.on("close", () => clearInterval(timer));
        return;
      }
      if (toolCall !== undefined) {
        json(res, 200, {
          id, object: "chat.completion", created, model,
          choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: toolCall }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
        });
        return;
      }
      json(res, 200, {
        id, object: "chat.completion", created, model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 }
      });
      return;
    }
    json(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}`, type: "not_found" } });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}`);
});
