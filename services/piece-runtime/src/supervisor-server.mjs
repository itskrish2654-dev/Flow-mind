import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { basename, dirname, isAbsolute, normalize } from "node:path/posix";

import { PieceRuntimeError } from "./errors.mjs";
import {
  SUPERVISOR_BODY_TIMEOUT_MS,
  SUPERVISOR_FORCE_CLOSE_MS,
  SUPERVISOR_HEADERS_TIMEOUT_MS,
  SUPERVISOR_KEEP_ALIVE_TIMEOUT_MS,
  SUPERVISOR_MAX_CONTROL_CONNECTIONS,
  SUPERVISOR_MAX_REQUEST_BYTES,
  SUPERVISOR_MAX_RESPONSE_BYTES,
  SUPERVISOR_PROTOCOL_VERSION,
  SUPERVISOR_SHUTDOWN_GRACE_MS,
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
    let settled = false;
    const zeroChunks = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      bytes = 0;
    };
    const removeListeners = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeListeners();
      zeroChunks();
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      if (settled) return;
      if (bytes + chunk.length > SUPERVISOR_MAX_REQUEST_BYTES) {
        request.pause();
        if (Buffer.isBuffer(chunk)) chunk.fill(0);
        finish(new SupervisorError("SUPERVISOR_INVALID_REQUEST", 413));
        return;
      }
      bytes += chunk.length;
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => {
      const raw = Buffer.concat(chunks, bytes);
      try {
        finish(null, JSON.parse(raw.toString("utf8")));
      } catch {
        finish(new SupervisorError("SUPERVISOR_INVALID_REQUEST", 400));
      } finally {
        raw.fill(0);
      }
    };
    const onError = () => finish(new SupervisorError("SUPERVISOR_INVALID_REQUEST", 400));
    const onAborted = () => finish(new SupervisorError("SUPERVISOR_INVALID_REQUEST", 400));
    const timer = setTimeout(() => {
      request.pause();
      finish(new SupervisorError("SUPERVISOR_INVALID_REQUEST", 408));
    }, SUPERVISOR_BODY_TIMEOUT_MS);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

async function settlesWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true, () => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const controlConnections = new Set();
  server.headersTimeout = SUPERVISOR_HEADERS_TIMEOUT_MS;
  server.requestTimeout = SUPERVISOR_BODY_TIMEOUT_MS;
  server.keepAliveTimeout = SUPERVISOR_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = 1;
  server.maxConnections = SUPERVISOR_MAX_CONTROL_CONNECTIONS;
  server.on("connection", (socket) => {
    controlConnections.add(socket);
    socket.once("close", () => controlConnections.delete(socket));
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
      let failure = false;
      const closed = new Promise((resolve) => server.close(resolve));
      try {
        const shutdown = await service.shutdown(SUPERVISOR_SHUTDOWN_GRACE_MS).catch(() => null);
        if (!shutdown?.clean) failure = true;
        server.closeIdleConnections?.();
        if (!await settlesWithin(closed, SUPERVISOR_FORCE_CLOSE_MS)) {
          server.closeAllConnections?.();
          for (const socket of controlConnections) socket.destroy();
          if (!await settlesWithin(closed, SUPERVISOR_FORCE_CLOSE_MS)) failure = true;
        }
      } finally {
        for (const socket of controlConnections) socket.destroy();
        if (existsSync(socketPath)) unlinkSync(socketPath);
      }
      if (failure) throw new SupervisorError("SUPERVISOR_UNAVAILABLE", 503);
    },
  });
}
