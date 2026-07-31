// Minimal fake Ollama server on node:http for contract tests. Records every
// /api/chat request body and answers through a swappable responder so tests
// can gate completion (to observe queued -> running) or force failures.

import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeChatRequest {
  model: string;
  messages: Array<{ role: string; content: string; images?: string[] }>;
  format?: unknown;
  options?: { temperature?: number };
  stream?: boolean;
}

export type Responder = (
  body: FakeChatRequest,
) => Promise<{ status?: number; content?: string; rawBody?: string }>;

export interface FakeOllama {
  url: string;
  requests: FakeChatRequest[];
  setResponder(fn: Responder): void;
  close(): Promise<void>;
}

const DEFAULT_VERDICT =
  '{"verified": true, "confidence": "high", "reason": "flu shot present"}';

export async function startFakeOllama(): Promise<FakeOllama> {
  const requests: FakeChatRequest[] = [];
  let responder: Responder = async () => ({ content: DEFAULT_VERDICT });

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "gemma3:4b-it-qat" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void (async () => {
          const body = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ) as FakeChatRequest;
          requests.push(body);
          const reply = await responder(body);
          if (reply.rawBody !== undefined) {
            res.writeHead(reply.status ?? 200, {
              "content-type": "application/json",
            });
            res.end(reply.rawBody);
            return;
          }
          if (reply.status !== undefined && reply.status >= 400) {
            res.writeHead(reply.status, { "content-type": "text/plain" });
            res.end("fake ollama forced failure");
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              model: body.model,
              message: { role: "assistant", content: reply.content ?? "" },
              done: true,
            }),
          );
        })();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setResponder(fn: Responder) {
      responder = fn;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
