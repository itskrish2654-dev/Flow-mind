// Temporary, route-limited ingress for real Slack Events API acceptance.
// It does not log bodies or headers and never exposes the rest of the app.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const port = 8789;
const route = "/api/connectors/events/slack";
const maxBodyBytes = 1_000_000;

createServer((request, response) => {
  if (request.method !== "POST" || request.url !== route) {
    response.writeHead(404).end();
    return;
  }
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    response.writeHead(415).end();
    return;
  }
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > maxBodyBytes) {
      response.writeHead(413).end();
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", async () => {
    if (size > maxBodyBytes) return;
    const rawBody = Buffer.concat(chunks);
    const timestamp = String(request.headers["x-slack-request-timestamp"] ?? "");
    const signature = String(request.headers["x-slack-signature"] ?? "");
    const secret = process.env.FLOWMIND_CONNECTOR_SLACK_SIGNING_SECRET;
    const expected = secret && /^\d+$/.test(timestamp)
      ? `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(rawBody).digest("hex")}` : "";
    const signatureMatches = /^v0=[a-f0-9]{64}$/i.test(signature) && expected.length === signature.length
      && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    const challengeRequest = (() => {
      try { return JSON.parse(rawBody.toString("utf8"))?.type === "url_verification"; }
      catch { return false; }
    })();
    try {
      const upstream = await fetch(`http://127.0.0.1:3000${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-signature": String(request.headers["x-slack-signature"] ?? ""),
          "x-slack-request-timestamp": String(request.headers["x-slack-request-timestamp"] ?? ""),
          ...(request.headers["x-slack-retry-num"] ? { "x-slack-retry-num": String(request.headers["x-slack-retry-num"]) } : {}),
        },
        body: rawBody,
        signal: AbortSignal.timeout(8_000),
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      }).end(body);
      console.log(JSON.stringify({ status: upstream.status, challengeRequest,
        signaturePresent: signature.length > 0, timestampPresent: timestamp.length > 0,
        signatureMatchesConfiguredSecret: signatureMatches }));
    } catch {
      response.writeHead(502).end();
      console.log(JSON.stringify({ status: 502, challengeRequest,
        signaturePresent: signature.length > 0, timestampPresent: timestamp.length > 0,
        signatureMatchesConfiguredSecret: signatureMatches }));
    }
  });
}).listen(port, "127.0.0.1", () => console.log("slack_acceptance_ingress_ready"));
