import http from "node:http";

const DEFAULT_SOCKET_PATH = "/var/run/docker.sock";
const MAX_DOCKER_RESPONSE_BYTES = 256 * 1024;

export class DockerClientError extends Error {
  /** @param {string} kind @param {number | null} statusCode */
  constructor(kind = "unavailable", statusCode = null) {
    super("Docker Engine operation failed.");
    this.name = "DockerClientError";
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

function encodePath(value) {
  return encodeURIComponent(value).replaceAll("%2F", "%252F");
}

function parseJson(buffer) {
  if (buffer.length === 0) return null;
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new DockerClientError("malformed_response");
  }
}

export function decodeDockerMultiplexed(buffer, maximumStdoutBytes) {
  let offset = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdout = [];
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) throw new DockerClientError("malformed_stream");
    const stream = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if (length < 0 || offset + length > buffer.length) throw new DockerClientError("malformed_stream");
    if (stream === 1) {
      stdoutBytes += length;
      if (stdoutBytes > maximumStdoutBytes) throw new DockerClientError("stdout_limit");
      stdout.push(buffer.subarray(offset, offset + length));
    } else if (stream === 2) {
      stderrBytes += length;
      if (stderrBytes > 64 * 1024) throw new DockerClientError("stderr_limit");
    } else {
      throw new DockerClientError("malformed_stream");
    }
    offset += length;
  }
  return Buffer.concat(stdout, stdoutBytes);
}

export class DockerEngineClient {
  constructor({ socketPath = DEFAULT_SOCKET_PATH, requestTimeoutMs = 5_000 } = {}) {
    this.socketPath = socketPath;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  request(method, path, body = null, maximumBytes = MAX_DOCKER_RESPONSE_BYTES) {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve(value);
      };
      const request = http.request({
        socketPath: this.socketPath,
        method,
        path: `/v1.44${path}`,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {},
      }, (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maximumBytes) {
            response.destroy();
            finish(new DockerClientError("response_limit", response.statusCode));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once("end", () => {
          const output = Buffer.concat(chunks, bytes);
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            output.fill(0);
            finish(new DockerClientError(response.statusCode === 404 ? "not_found" : "daemon_failure", response.statusCode));
            return;
          }
          try {
            finish(null, parseJson(output));
          } catch (error) {
            finish(error);
          } finally {
            output.fill(0);
          }
        });
      });
      request.setTimeout(this.requestTimeoutMs, () => request.destroy(new DockerClientError("timeout")));
      request.once("error", () => finish(new DockerClientError("unavailable")));
      if (payload) request.end(payload); else request.end();
    });
  }

  async createNetwork(configuration) {
    return this.request("POST", "/networks/create", configuration);
  }

  async inspectNetwork(name) {
    return this.request("GET", `/networks/${encodePath(name)}`);
  }

  async connectNetwork(name, configuration) {
    await this.request("POST", `/networks/${encodePath(name)}/connect`, configuration);
  }

  async removeNetwork(name) {
    await this.request("DELETE", `/networks/${encodePath(name)}`);
  }

  async listNetworks(label) {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    return this.request("GET", `/networks?filters=${filters}`);
  }

  async createContainer(name, configuration) {
    return this.request("POST", `/containers/create?name=${encodeURIComponent(name)}`, configuration);
  }

  async startContainer(name) {
    await this.request("POST", `/containers/${encodePath(name)}/start`);
  }

  async inspectContainer(name) {
    return this.request("GET", `/containers/${encodePath(name)}/json`);
  }

  async killContainer(name) {
    await this.request("POST", `/containers/${encodePath(name)}/kill?signal=KILL`);
  }

  async removeContainer(name) {
    await this.request("DELETE", `/containers/${encodePath(name)}?force=1&v=1`);
  }

  async listContainers(label) {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    return this.request("GET", `/containers/json?all=1&filters=${filters}`);
  }

  async containerLogs(name, maximumBytes = 32 * 1024) {
    return this.rawRequest("GET", `/containers/${encodePath(name)}/logs?stdout=1&stderr=1&tail=100`, maximumBytes);
  }

  rawRequest(method, path, maximumBytes) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let bytes = 0;
      const request = http.request({ socketPath: this.socketPath, method, path: `/v1.44${path}` }, (response) => {
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maximumBytes) {
            response.destroy();
            reject(new DockerClientError("response_limit"));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.once("end", () => {
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new DockerClientError(response.statusCode === 404 ? "not_found" : "daemon_failure", response.statusCode));
            return;
          }
          resolve(Buffer.concat(chunks, bytes));
        });
      });
      request.setTimeout(this.requestTimeoutMs, () => request.destroy(new DockerClientError("timeout")));
      request.once("error", () => reject(new DockerClientError("unavailable")));
      request.end();
    });
  }

  attachAndRun({ name, input, maximumStdoutBytes, timeoutMs, signal }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket = null;
      const chunks = [];
      let bytes = 0;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        socket?.destroy();
        if (error) reject(error); else resolve(value);
      };
      const terminate = (kind) => {
        void this.killContainer(name).catch(() => undefined);
        finish(new DockerClientError(kind));
      };
      const abort = () => terminate("aborted");
      const timer = setTimeout(() => terminate("timeout"), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      const request = http.request({
        socketPath: this.socketPath,
        method: "POST",
        path: `/v1.44/containers/${encodePath(name)}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
        headers: { Connection: "Upgrade", Upgrade: "tcp" },
      });
      request.once("upgrade", (_response, upgraded, head) => {
        socket = upgraded;
        if (head.length) {
          bytes += head.length;
          chunks.push(Buffer.from(head));
        }
        socket.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maximumStdoutBytes + 64 * 1024 + 8192) return terminate("stdout_limit");
          chunks.push(Buffer.from(chunk));
        });
        socket.once("error", () => finish(new DockerClientError("stream_failure")));
        socket.once("end", () => {
          try {
            const combined = Buffer.concat(chunks, bytes);
            const output = decodeDockerMultiplexed(combined, maximumStdoutBytes);
            combined.fill(0);
            finish(null, output);
          } catch (error) {
            finish(error);
          }
        });
        void this.startContainer(name)
          .then(() => {
            if (settled) return;
            socket.end(input);
          })
          .catch(() => finish(new DockerClientError("start_failure")));
      });
      request.once("response", () => finish(new DockerClientError("attach_failure")));
      request.once("error", () => finish(new DockerClientError("attach_failure")));
      request.end();
    });
  }
}
