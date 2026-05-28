/**
 * Lightweight reverse proxy that injects DeepSeek-specific parameters
 * into OpenAI-compatible chat completion requests.
 *
 * Problem: DeepSeek v4-flash is a reasoning model that returns `reasoning_content`
 * in responses. The Copilot SDK doesn't pass this back in subsequent turns,
 * causing 400 errors ("reasoning_content must be passed back").
 *
 * Solution: Inject `thinking: {type: "disabled"}` into every request body,
 * which tells DeepSeek API to disable thinking mode entirely.
 *
 * Usage:
 *   npx tsx src/server/deepseekProxy.ts
 *
 * Environment:
 *   DEEPSEEK_API_KEY   — required, your DeepSeek API key
 *   DEEPSEEK_BASE_URL  — optional, defaults to https://api.deepseek.com
 *   PROXY_PORT         — optional, defaults to 8765
 *   HTTPS_PROXY        — optional, corporate proxy for outbound HTTPS
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { HttpsProxyAgent } from "https-proxy-agent";

const UPSTREAM_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const PROXY_PORT = parseInt(process.env.PROXY_PORT || "8765", 10);
const API_KEY = process.env.DEEPSEEK_API_KEY;

if (!API_KEY) {
  console.error("[deepseek-proxy] ERROR: DEEPSEEK_API_KEY is required");
  process.exit(1);
}

const upstreamUrl = new URL(UPSTREAM_BASE);

// Build an agent that routes through corporate HTTPS_PROXY if set
const corporateProxyUrl =
  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

const upstreamAgent = corporateProxyUrl
  ? new HttpsProxyAgent(corporateProxyUrl)
  : undefined;

if (upstreamAgent) {
  console.log(`[deepseek-proxy] Using corporate proxy: ${corporateProxyUrl}`);
}

function injectThinkingDisabled(body: Record<string, unknown>): void {
  body.thinking = { type: "disabled" };
  delete body.reasoning_effort;
  delete body.reasoningEffort;
}

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];

  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf-8");

    let bodyObj: Record<string, unknown>;
    try {
      bodyObj = JSON.parse(rawBody);
    } catch {
      bodyObj = {};
    }

    // Inject thinking disabled for chat completion requests
    if (req.url && (req.url.includes("/chat/completions") || req.url.includes("/v1/chat/completions"))) {
      injectThinkingDisabled(bodyObj);
      console.log(
        `[deepseek-proxy] ${req.method} ${req.url} → injected thinking.type=disabled (model=${bodyObj.model || "default"})`
      );
    } else {
      console.log(`[deepseek-proxy] ${req.method} ${req.url} → forwarded as-is`);
    }

    const targetPath = req.url || "/";
    const outBody = Object.keys(bodyObj).length > 0 ? JSON.stringify(bodyObj) : rawBody;
    const upstreamHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(outBody)),
      "Authorization": `Bearer ${API_KEY}`,
    };

    const options: https.RequestOptions = {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || 443,
      path: targetPath,
      method: req.method,
      headers: upstreamHeaders,
      ...(upstreamAgent ? { agent: upstreamAgent as unknown as https.Agent } : {}),
    };

    const proto = upstreamUrl.protocol === "http:" ? http : https;
    const upstreamReq = proto.request(options, (upstreamRes) => {
      console.log(`[deepseek-proxy] upstream status: ${upstreamRes.statusCode}`);
      const respHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (v !== undefined) {
          respHeaders[k] = v;
        }
      }
      res.writeHead(upstreamRes.statusCode || 502, respHeaders);
      upstreamRes.pipe(res, { end: true });
    });

    upstreamReq.on("error", (err) => {
      console.error("[deepseek-proxy] upstream error:", err.message);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
      }
      res.end(JSON.stringify({ error: { message: `proxy upstream error: ${err.message}` } }));
    });

    upstreamReq.write(outBody);
    upstreamReq.end();
  });

  req.on("error", (err) => {
    console.error("[deepseek-proxy] client error:", err.message);
    res.writeHead(400);
    res.end();
  });
});

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(`[deepseek-proxy] Listening on http://127.0.0.1:${PROXY_PORT}`);
  console.log(`[deepseek-proxy] Upstream: ${UPSTREAM_BASE}`);
  console.log(`[deepseek-proxy] Injecting: thinking.type=disabled`);
});
