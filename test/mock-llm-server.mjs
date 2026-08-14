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
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const userText = lastUser ? String(lastUser.content ?? "") : "(no user message)";
      const text = `MOCK-REPLY: ${userText}`;
      const model = String(parsed.model ?? "mock-model");
      const id = `mock-chat-${Math.floor(Math.random() * 1e9)}`;
      const created = Math.floor(Date.now() / 1000);
      if (parsed.stream === true) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
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
