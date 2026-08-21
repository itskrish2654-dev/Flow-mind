import net from "node:net";
import tls from "node:tls";

const DEFAULT_TIMEOUT_MS = 1_000;
const REPLAY_PREFIX = "crazyloops:connector-runner:v1:replay:";

function encodeCommand(parts) {
  const encoded = parts.map((part) => {
    const value = Buffer.from(String(part), "utf8");
    return Buffer.concat([
      Buffer.from(`$${value.length}\r\n`, "ascii"),
      value,
      Buffer.from("\r\n", "ascii"),
    ]);
  });
  return Buffer.concat([
    Buffer.from(`*${parts.length}\r\n`, "ascii"),
    ...encoded,
  ]);
}

function parseResponse(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const marker = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf("\r\n", offset + 1, "ascii");
  if (lineEnd < 0) return null;
  const line = buffer.subarray(offset + 1, lineEnd).toString("utf8");
  const next = lineEnd + 2;
  if (marker === "+") return { value: line, next };
  if (marker === ":") return { value: Number(line), next };
  if (marker === "-") return { error: new Error("Redis command failed."), next };
  if (marker === "$") {
    const length = Number(line);
    if (length === -1) return { value: null, next };
    if (!Number.isSafeInteger(length) || length < 0 || buffer.length < next + length + 2) {
      return null;
    }
    return {
      value: buffer.subarray(next, next + length).toString("utf8"),
      next: next + length + 2,
    };
  }
  return { error: new Error("Redis response was invalid."), next };
}

function parseRedisConfiguration(serializedUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let url;
  try {
    url = new URL(serializedUrl);
  } catch {
    throw new Error("Replay protection is unavailable.");
  }
  if (!new Set(["redis:", "rediss:"]).has(url.protocol) || !url.hostname || url.search || url.hash) {
    throw new Error("Replay protection is unavailable.");
  }
  const databaseText = url.pathname.replace(/^\//, "");
  const database = databaseText === "" ? 0 : Number(databaseText);
  if (!Number.isSafeInteger(database) || database < 0 || database > 15) {
    throw new Error("Replay protection is unavailable.");
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    tls: url.protocol === "rediss:",
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    timeoutMs: Math.max(100, Math.min(5_000, timeoutMs)),
  };
}

async function runCommands(configuration, commands) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let received = Buffer.alloc(0);
    const results = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const options = { host: configuration.host, port: configuration.port };
    const socket = configuration.tls
      ? tls.connect({ ...options, servername: configuration.host })
      : net.connect(options);
    socket.setTimeout(configuration.timeoutMs);
    socket.once("timeout", () => finish(new Error("Replay protection is unavailable.")));
    socket.once("error", () => finish(new Error("Replay protection is unavailable.")));
    socket.once("connect", () => {
      socket.write(Buffer.concat(commands.map(encodeCommand)));
    });
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      let offset = 0;
      while (results.length < commands.length) {
        const parsed = parseResponse(received, offset);
        if (!parsed) break;
        offset = parsed.next;
        if (parsed.error) {
          finish(new Error("Replay protection is unavailable."));
          return;
        }
        results.push(parsed.value);
      }
      if (offset > 0) received = received.subarray(offset);
      if (results.length === commands.length) finish(null, results);
    });
  });
}

export class RedisReplayStore {
  constructor({ url, timeoutMs } = {}) {
    this.configuration = parseRedisConfiguration(url, timeoutMs);
  }

  async claim({ fingerprint, ttlMs }) {
    if (!/^[a-f0-9]{64}$/.test(fingerprint) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 120_000) {
      throw new Error("Replay protection is unavailable.");
    }
    const commands = [];
    if (this.configuration.password) {
      commands.push(this.configuration.username
        ? ["AUTH", this.configuration.username, this.configuration.password]
        : ["AUTH", this.configuration.password]);
    }
    if (this.configuration.database !== 0) {
      commands.push(["SELECT", String(this.configuration.database)]);
    }
    commands.push([
      "SET",
      `${REPLAY_PREFIX}${fingerprint}`,
      "1",
      "NX",
      "PX",
      String(ttlMs),
    ]);
    const results = await runCommands(this.configuration, commands);
    const claimResult = results.at(-1);
    if (claimResult === "OK") return true;
    if (claimResult === null) return false;
    throw new Error("Replay protection is unavailable.");
  }
}

export function createRedisReplayStoreFromEnvironment() {
  const timeoutMs = Number.parseInt(process.env.CONNECTOR_RUNNER_REDIS_TIMEOUT_MS ?? "", 10);
  return new RedisReplayStore({
    url: process.env.CONNECTOR_RUNNER_REDIS_URL ?? "",
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
  });
}
