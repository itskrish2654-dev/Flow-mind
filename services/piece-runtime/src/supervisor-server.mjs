import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { basename, dirname, isAbsolute, normalize } from "node:path/posix";

import { PieceRuntimeError } from "./errors.mjs";
import {
  SUPERVISOR_MAX_REQUEST_BYTES,
  SUPERVISOR_MAX_RESPONSE_BYTES,
  SUPERVISOR_PROTOCOL_VERSION,
  SUPERVISOR_SOCKET_DIRECTORY,
  SUPERVISOR_SOCKET_DIRECTORY_MODE,
  SUPERVISOR_SOCKET_MODE,
  SUPERVISOR_SOCKET_PATH,
} from "./supervisor-constants.mjs";
import { sanitizeSupervisorFailure, SupervisorError } from "./supervisor-errors.mjs";

function exactSocketPath(value) {
  return typeof value === "string" && isAbsolute(value) && normalize(value) === value &&
    dirname(value) === SUPERVISOR_SOCKET_DIRECTORY && basename(value) === basename(SUPERVISOR_SOCKET_PATH);
}

export function validateSupervisorSocketPath(value) {
  if (!exactSocketPath(value)) throw new SupervisorError("SUPERVISOR_UNAVAILABLE", 503);
  return value;
}

function activeSocket(path) {
  return new Promise((resolve) => {
    const socket = net.createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function claimSocket(path) {
  mkdirSync(dirname(path), { recursive: true, mode: SUPERVISOR_SOCKET_DIRECTORY_MODE });
  chmodSync(dirname(path), SUPERVISOR_SOCKET_DIRECTORY_MODE);
  if (existsSync(path)) {
    const status = statSync(path);
    if (!status.isSocket() || await activeSocket(path)) throw new SupervisorError("SUPERVISOR_UNAVAILABLE", 503);
    unlinkSync(path);
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > SUPERVISOR_MAX_REQUEST_BYTES) {
        request.destroy();
        reject(new SupervisorError("SUPERVISOR_INVALID_REQUEST", 413));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.once("end", () => {
      const raw = Buffer.concat(chunks, bytes);
      try {
        resolve(JSON.parse(raw.toString("utf8")));
      } catch {
        reject(new SupervisorError("SUPERVISOR_INVALID_REQUEST", 400));
      } finally {
        raw.fill(0);
        for (const chunk of chunks) chunk.fill(0);
      }
    });
    request.once("error", () => reject(new SupervisorError("SUPERVISOR_INVALID_REQUEST", 400)));
  });
}

function boundedResponse(response, statusCode, value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = JSON.stringify({ ok: false, protocolVersion: SUPERVISOR_PROTOCOL_VERSION, errorCode: "SUPERVISOR_UNAVAILABLE" });
    statusCode = 503;
  }
  if (Buffer.byteLength(serialized, "utf8") > SUPERVISOR_MAX_RESPONSE_BYTES) {
    serialized = JSON.stringify({ ok: false, protocolVersion: SUPERVISOR_PROTOCOL_VERSION, errorCode: "SUPERVISOR_UNAVAILABLE" });
    statusCode = 503;
  }
  response.writeHead(statusCode, { "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(serialized) });
  response.end(serialized);
}

function safeError(error) {
  if (error instanceof PieceRuntimeError) {
    return { statusCode: 422, body: { ok: false, protocolVersion: 1, errorCode: error.code, retryable: error.retryable } };
  }
  const normalized = sanitizeSupervisorFailure(error);
  return { statusCode: normalized.statusCode, body: { ok: false, protocolVersion: 1, errorCode: normalized.code } };
}

export async function startSupervisorServer({ service, engine, socketPath = SUPERVISOR_SOCKET_PATH, logger = () => undefined }) {
  validateSupervisorSocketPath(socketPath);
  await claimSocket(socketPath);
  const server = http.createServer(async (request, response) => {
    response.setHeader("Connection", "close");
    if (request.method === "GET" && request.url === "/v1/health") {
      boundedResponse(response, service.health().ok ? 200 : 503, service.health());
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/execute" || request.headers["content-type"] !== "application/json") {
      boundedResponse(response, 404, { ok: false, protocolVersion: 1, errorCode: "SUPERVISOR_INVALID_REQUEST" });
      return;
    }
    const controller = new AbortController();
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    try {
      const envelope = await readJson(request);
      const result = await service.execute(envelope, controller.signal);
      boundedResponse(response, 200, result);
    } catch (error) {
      const safe = safeError(error);
      boundedResponse(response, safe.statusCode, safe.body);
    }
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, SUPERVISOR_SOCKET_MODE);
  try {
    await engine.cleanupOrphans();
    service.setReady();
  } catch (error) {
    server.close();
    if (existsSync(socketPath)) unlinkSync(socketPath);
    throw sanitizeSupervisorFailure(error);
  }
  try { logger(Object.freeze({ event: "piece_supervisor_ready", protocolVersion: 1, status: "ready" })); } catch {}
  let stopping = false;
  return Object.freeze({
    server,
    socketPath,
    async stop() {
      if (stopping) return;
      stopping = true;
      const closed = new Promise((resolve) => server.close(resolve));
      await service.shutdown();
      await closed;
      if (existsSync(socketPath)) unlinkSync(socketPath);
    },
  });
}
