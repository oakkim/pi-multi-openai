/**
 * Minimal OpenAI-compatible mock server for e2e failover tests.
 *
 * - POST /v1/chat/completions: keys containing "sk-dead" get 429
 *   insufficient_quota; any other key streams a short completion that
 *   identifies which key was used.
 * - GET /v1/models: 200 with mock-model.
 */

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 8931);

const server = http.createServer((req, res) => {
  const auth = req.headers.authorization ?? "";
  const usedKey = auth.replace(/^Bearer\s+/i, "");

  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (usedKey.includes("sk-dead")) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "You exceeded your current quota, please check your plan and billing details.",
              type: "insufficient_quota",
              code: "insufficient_quota",
            },
          }),
        );
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "mock-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: `MOCK-OK:${usedKey}` }));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `no route ${req.method} ${req.url}` } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock server listening on http://127.0.0.1:${PORT}`);
});
