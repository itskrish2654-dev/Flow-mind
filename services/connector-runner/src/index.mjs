import http from "node:http";

import { createRedisReplayStoreFromEnvironment } from "./redis.mjs";
import {
  MAX_REQUEST_BYTES,
  processRunnerRequest,
  parseRunnerKeyRingFromEnvironment,
  serializeResponse,
} from "./runner.mjs";

function integerEnvironment(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

const host = process.env.CONNECTOR_RUNNER_HOST || "127.0.0.1";
const port = integerEnvironment("CONNECTOR_RUNNER_PORT", 8788, 1, 65_535);
const adapterTimeoutMs = integerEnvironment(
  "CONNECTOR_RUNNER_ADAPTER_TIMEOUT_MS",
  10_000,
  100,
  30_000,
);
const transportSecret = process.env.CONNECTOR_RUNNER_SECRET ?? "";
const keyRing = parseRunnerKeyRingFromEnvironment();
if ([...keyRing.values()].some((key) => key.toString("base64") === transportSecret)) {
  throw new Error("Connector runner secrets must be independent.");
}
const replayStore = createRedisReplayStoreFromEnvironment();

const logger = (event) => console.info(JSON.stringify(event));

const server = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/execute") {
    response.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ ok: false }));
    return;
  }
  if ((request.headers["content-type"] ?? "").split(";", 1)[0].trim() !== "application/json") {
    response.writeHead(415, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ ok: false }));
    return;
  }
  let size = 0;
  const chunks = [];
  let rejected = false;
  request.on("data", (chunk) => {
    if (rejected) return;
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      rejected = true;
      response.writeHead(413, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ ok: false }));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", async () => {
    if (rejected) return;
    const result = await processRunnerRequest({
      rawBody: Buffer.concat(chunks).toString("utf8"),
      headers: request.headers,
      transportSecret,
      keyRing,
      replayStore,
      adapterTimeoutMs,
      logger,
    });
    response.writeHead(result.status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(serializeResponse(result));
  });
});

server.listen(port, host, () => {
  console.info(JSON.stringify({ event: "connector_runner_listening", host, port }));
});
