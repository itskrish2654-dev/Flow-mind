import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  createHubSpotGetContactAdapter,
  HUBSPOT_GET_CONTACT_CAPABILITY,
  HUBSPOT_GET_CONTACT_VERSION,
  SUPERVISOR_ERROR_MAPPING,
} from "../services/connector-runner/src/adapters/hubspot.mjs";
import {
  createPieceSupervisorClient,
  PIECE_SUPERVISOR_EXECUTE_PATH,
  PIECE_SUPERVISOR_MAX_REQUEST_BYTES,
  PIECE_SUPERVISOR_SOCKET_PATH,
  PieceSupervisorClientError,
  validatePieceSupervisorSocketPath,
} from "../services/connector-runner/src/piece-supervisor-client.mjs";
import { CANARY_CAPABILITY, createRunnerAdapters, RunnerError } from "../services/connector-runner/src/runner.mjs";

const REQUEST = Object.freeze({
  protocolVersion: 1,
  requestId: "request-step5b2-1",
  executionId: "execution-step5b2-1",
  capabilityId: HUBSPOT_GET_CONTACT_CAPABILITY,
  capabilityVersion: HUBSPOT_GET_CONTACT_VERSION,
  mode: "TEST",
  idempotencyKey: "idempotency-step5b2-1",
  input: { contactId: "synthetic-contact", properties: ["firstname"] },
});
const CREDENTIAL = "STEP5B2_SECRET_CANARY";

function successResponse(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    requestId: REQUEST.requestId,
    ok: true,
    acknowledged: true,
    output: { contactId: "synthetic-contact", properties: { firstname: "Ada" } },
    meta: {
      capabilityId: HUBSPOT_GET_CONTACT_CAPABILITY,
      capabilityVersion: HUBSPOT_GET_CONTACT_VERSION,
      providerId: "hubspot",
      pieceVersion: "0.8.10",
      actionId: "get-contact",
      classification: "READ",
      attempts: 1,
    },
    ...overrides,
  };
}

type FakeMode = "success" | "timeout" | "disconnect" | "error";

function fakeHttp(responseValue: unknown, mode: FakeMode = "success") {
  const calls: Array<{ options: Record<string, unknown>; body: Buffer }> = [];
  let timeoutCallback: (() => void) | null = null;
  let destroyed = false;
  const requestImplementation = (options: Record<string, unknown>, callback: (response: EventEmitter & { statusCode: number; destroy(): void }) => void) => {
    const request = new EventEmitter() as EventEmitter & {
      setTimeout(milliseconds: number, callback: () => void): void;
      end(body: Buffer): void;
      destroy(): void;
    };
    request.setTimeout = (_milliseconds, callback) => { timeoutCallback = callback; };
    request.destroy = () => { destroyed = true; };
    request.end = (body) => {
      calls.push({ options, body });
      if (mode === "timeout") {
        queueMicrotask(() => timeoutCallback?.());
        return;
      }
      if (mode === "error") {
        queueMicrotask(() => request.emit("error", new Error("private socket detail")));
        return;
      }
      const response = new EventEmitter() as EventEmitter & { statusCode: number; destroy(): void };
      response.statusCode = 200;
      response.destroy = () => undefined;
      queueMicrotask(() => {
        callback(response);
        if (mode === "disconnect") {
          response.emit("aborted");
          return;
        }
        response.emit("data", Buffer.from(typeof responseValue === "string" ? responseValue : JSON.stringify(responseValue)));
        response.emit("end");
      });
    };
    return request;
  };
  return {
    requestImplementation,
    calls,
    destroyed: () => destroyed,
  };
}

function clientFor(responseValue: unknown, mode: FakeMode = "success") {
  const fake = fakeHttp(responseValue, mode);
  return { fake, client: createPieceSupervisorClient({ requestImplementation: fake.requestImplementation }) };
}

function fail(category: string, retryable = false) {
  throw new RunnerError(category, retryable, 200);
}

async function executeAdapter(input: {
  response?: unknown;
  mode?: FakeMode;
  requestOverrides?: Record<string, unknown>;
  signal?: AbortSignal;
} = {}) {
  const { fake, client } = clientFor(input.response ?? successResponse(), input.mode);
  const adapter = createHubSpotGetContactAdapter({ fail, supervisorClient: client });
  const credential = Buffer.from(CREDENTIAL);
  try {
    const output = await adapter.execute({
      ...REQUEST,
      ...input.requestOverrides,
      credential,
      signal: input.signal ?? new AbortController().signal,
    });
    return { output, fake, credential };
  } catch (error) {
    return { error, fake, credential };
  }
}

test("5B.2A uses only the exact reviewed Supervisor UDS and execute path", async () => {
  assert.equal(validatePieceSupervisorSocketPath(PIECE_SUPERVISOR_SOCKET_PATH), PIECE_SUPERVISOR_SOCKET_PATH);
  for (const path of ["piece-supervisor.sock", "/tmp/piece-supervisor.sock", `${PIECE_SUPERVISOR_SOCKET_PATH}/..`, "http://127.0.0.1:8789"]) {
    assert.throws(() => validatePieceSupervisorSocketPath(path), /Piece supervisor request failed/);
  }
  const { fake } = await executeAdapter();
  assert.equal(fake.calls.length, 1);
  const options = fake.calls[0].options;
  assert.equal(options.socketPath, PIECE_SUPERVISOR_SOCKET_PATH);
  assert.equal(options.path, PIECE_SUPERVISOR_EXECUTE_PATH);
  assert.equal(options.method, "POST");
  assert.equal(options.agent, false);
  assert.equal("host" in options, false);
  assert.equal("hostname" in options, false);
  assert.equal("port" in options, false);
});

test("5B.2A sends the exact Supervisor v1 envelope without Runner internals", async () => {
  const { fake, output } = await executeAdapter();
  assert.deepEqual(output, successResponse().output);
  const body = fake.calls[0].body;
  const beforeZeroing = body.toString("utf8");
  // The client has returned, so every bridge-owned request byte has been cleared.
  assert.equal(body.every((byte) => byte === 0), true);
  assert.equal(beforeZeroing, "\0".repeat(body.length));
  const source = readFileSync(resolve("services/connector-runner/src/piece-supervisor-client.mjs"), "utf8");
  assert.match(source, /protocolVersion: PROTOCOL_VERSION,[\s\S]*request,[\s\S]*credentialBase64/);
  for (const forbidden of ["workflowVersionId", "stepId", "credentialCapsule", "x-crazyloops-signature", "wrapKey", "replayStore"]) {
    assert.doesNotMatch(source, new RegExp(forbidden, "i"));
  }
});

test("5B.2A request metadata and credential are projected only into the approved envelope", async () => {
  const fake = fakeHttp(successResponse());
  let capturedBody = "";
  const implementation = (options: Record<string, unknown>, callback: Parameters<typeof fake.requestImplementation>[1]) => {
    const request = fake.requestImplementation(options, callback);
    const originalEnd = request.end;
    request.end = (body: Buffer) => {
      capturedBody = body.toString("utf8");
      originalEnd(body);
    };
    return request;
  };
  const client = createPieceSupervisorClient({ requestImplementation: implementation });
  await client.execute({ request: REQUEST, credential: Buffer.from(CREDENTIAL), signal: new AbortController().signal });
  const envelope = JSON.parse(capturedBody);
  assert.deepEqual(Object.keys(envelope).sort(), ["credentialBase64", "protocolVersion", "request"]);
  assert.deepEqual(envelope.request, REQUEST);
  assert.equal(Buffer.from(envelope.credentialBase64, "base64").toString("utf8"), CREDENTIAL);
  assert.equal(capturedBody.includes("workflowVersionId"), false);
  assert.equal(capturedBody.includes("credentialCapsule"), false);
});

test("5B.2A bounds requests before opening the UDS", async () => {
  const fake = fakeHttp(successResponse());
  const client = createPieceSupervisorClient({ requestImplementation: fake.requestImplementation });
  await assert.rejects(
    client.execute({
      request: { ...REQUEST, input: { value: "x".repeat(PIECE_SUPERVISOR_MAX_REQUEST_BYTES) } },
      credential: Buffer.from(CREDENTIAL),
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof PieceSupervisorClientError && error.kind === "request_too_large",
  );
  assert.equal(fake.calls.length, 0);
});

test("5B.2A bounds and strictly validates Supervisor responses", async () => {
  for (const response of [
    "not-json",
    { ...successResponse(), extra: true },
    { ...successResponse(), requestId: "wrong" },
    { ...successResponse(), acknowledged: false },
    { ...successResponse(), meta: { ...successResponse().meta, attempts: 2 } },
  ]) {
    const result = await executeAdapter({ response });
    assert.ok(result.error instanceof RunnerError);
    assert.equal(result.error.category, "DELEGATED_BAD_RESPONSE");
  }
  const oversized = await executeAdapter({ response: "x".repeat(192 * 1024 + 1) });
  assert.ok(oversized.error instanceof RunnerError);
  assert.equal(oversized.error.category, "DELEGATED_BAD_RESPONSE");
});

test("5B.2A timeout, caller abort, and disconnect fail closed without retrying", async () => {
  const timeout = await executeAdapter({ mode: "timeout" });
  assert.ok(timeout.error instanceof RunnerError);
  assert.equal(timeout.error.category, "DELEGATED_TIMEOUT");
  assert.equal(timeout.fake.calls.length, 1);
  assert.equal(timeout.fake.destroyed(), true);

  const controller = new AbortController();
  controller.abort();
  const aborted = await executeAdapter({ signal: controller.signal });
  assert.ok(aborted.error instanceof RunnerError);
  assert.equal(aborted.error.category, "DELEGATED_TIMEOUT");
  assert.equal(aborted.fake.calls.length, 0);

  const disconnected = await executeAdapter({ mode: "disconnect" });
  assert.ok(disconnected.error instanceof RunnerError);
  assert.equal(disconnected.error.category, "DELEGATED_UNAVAILABLE");
  assert.equal(disconnected.fake.calls.length, 1);
});

test("5B.2A exhaustively maps reviewed Piece errors into existing Runner vocabulary", async () => {
  const expected = {
    PIECE_UNSUPPORTED_CAPABILITY: ["DELEGATED_UNSUPPORTED_CAPABILITY", false],
    PIECE_INVALID_CREDENTIAL: ["DELEGATED_AUTH_FAILED", false],
    PIECE_AUTH_FAILED: ["DELEGATED_AUTH_FAILED", false],
    PIECE_RATE_LIMITED: ["DELEGATED_RATE_LIMITED", true],
    PIECE_PROVIDER_UNAVAILABLE: ["DELEGATED_UNAVAILABLE", true],
    PIECE_TIMEOUT: ["DELEGATED_TIMEOUT", true],
    PIECE_EGRESS_DENIED: ["DELEGATED_EXECUTION_FAILED", false],
    PIECE_RESPONSE_INVALID: ["DELEGATED_BAD_RESPONSE", false],
    PIECE_RUNTIME_FAILED: ["DELEGATED_EXECUTION_FAILED", false],
    PIECE_INVALID_INPUT: ["DELEGATED_EXECUTION_FAILED", false],
    PIECE_ACTION_NOT_ALLOWED: ["DELEGATED_UNSUPPORTED_CAPABILITY", false],
    PIECE_OUTPUT_LIMIT: ["DELEGATED_BAD_RESPONSE", false],
  } as const;
  assert.deepEqual(SUPERVISOR_ERROR_MAPPING, expected);
  for (const [errorCode, [category, retryable]] of Object.entries(expected)) {
    const result = await executeAdapter({ response: {
      protocolVersion: 1,
      requestId: REQUEST.requestId,
      ok: false,
      errorCode,
      retryable,
    } });
    assert.ok(result.error instanceof RunnerError, errorCode);
    assert.equal(result.error.category, category, errorCode);
    assert.equal(result.error.retryable, retryable, errorCode);
    assert.equal(result.fake.calls.length, 1, errorCode);
  }
});

test("5B.2A maps unknown Supervisor failures to the generic delegated failure", async () => {
  const result = await executeAdapter({ response: {
    protocolVersion: 1,
    requestId: REQUEST.requestId,
    ok: false,
    errorCode: "PIECE_FUTURE_UNKNOWN",
    retryable: false,
  } });
  assert.ok(result.error instanceof RunnerError);
  assert.equal(result.error.category, "DELEGATED_EXECUTION_FAILED");
  assert.equal(result.error.retryable, false);
});

test("5B.2A registers only hubspot.get_contact version 1 beside existing adapters", () => {
  const client = { execute: async () => successResponse() };
  const adapters = createRunnerAdapters({ supervisorClient: client });
  assert.equal(adapters.has("hubspot.get_contact@1"), true);
  assert.equal(adapters.has("hubspot.get_contact@2"), false);
  assert.equal(adapters.has("hubspot.create_contact@1"), false);
  assert.equal(adapters.has(`${CANARY_CAPABILITY}@1`), true);
  assert.equal(adapters.has("airtable.create_record@1"), true);
  assert.equal(adapters.size, 3);
});

test("5B.2A preserves existing Airtable and internal canary behavior", async () => {
  const adapters = createRunnerAdapters({ supervisorClient: { execute: async () => successResponse() } });
  const credential = Buffer.from("existing-adapter-credential");
  const signal = new AbortController().signal;
  const canary = adapters.get(`${CANARY_CAPABILITY}@1`);
  assert.ok(canary);
  assert.deepEqual(await canary.execute({
    credential,
    input: { simulation: "success" },
    signal,
    fetchImplementation: fetch,
  }), {
    proof: createHmac("sha256", credential).update("CrazyLoops runner proof").digest("hex"),
  });

  const airtable = adapters.get("airtable.create_record@1");
  assert.ok(airtable);
  let fetches = 0;
  const airtableResult = await airtable.execute({
    input: {
      baseId: "app12345678901234",
      tableId: "tbl12345678901234",
      fields: { Name: "Ada" },
    },
    credential,
    signal,
    fetchImplementation: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ records: [{ id: "rec12345678901234" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.deepEqual(airtableResult, { recordId: "rec12345678901234" });
  assert.equal(fetches, 1);
});

test("5B.2A rejects LIVE and nonreviewed HubSpot variants before Supervisor I/O", async () => {
  for (const requestOverrides of [
    { mode: "LIVE" },
    { capabilityVersion: 2 },
    { capabilityId: "hubspot.create_contact" },
  ]) {
    const result = await executeAdapter({ requestOverrides });
    assert.ok(result.error instanceof RunnerError);
    assert.equal(result.error.category, "DELEGATED_UNSUPPORTED_CAPABILITY");
    assert.equal(result.fake.calls.length, 0);
  }
});

test("5B.2A does not use fetch, TCP, redirects, keepalive, or retries", () => {
  const clientSource = readFileSync(resolve("services/connector-runner/src/piece-supervisor-client.mjs"), "utf8");
  const adapterSource = readFileSync(resolve("services/connector-runner/src/adapters/hubspot.mjs"), "utf8");
  assert.doesNotMatch(`${clientSource}\n${adapterSource}`, /\bfetch\s*\(/);
  assert.doesNotMatch(clientSource, /createConnection|hostname:|port:|redirect|docker\.sock|egress-broker/i);
  assert.doesNotMatch(clientSource, /for\s*\([^)]*attempt|while\s*\([^)]*attempt|setInterval|retryCount/i);
  assert.doesNotMatch(`${clientSource}\n${adapterSource}`, /process\.env|process\.argv|console\.|writeFile|appendFile|spawn\(|exec\(/i);
  assert.match(clientSource, /agent: false/);
  assert.match(clientSource, /"Connection": "close"/);
  assert.doesNotMatch(adapterSource, /api\.hubapi\.com|activepieces|docker|manifest|broker/i);
});

test("5B.2A preserves Runner-owned credential zeroing and does not leak sensitive failures", async () => {
  const runnerSource = readFileSync(resolve("services/connector-runner/src/runner.mjs"), "utf8");
  assert.match(runnerSource, /finally \{[\s\S]*credential\.fill\(0\);[\s\S]*\}/);
  const requestPath = runnerSource.slice(runnerSource.indexOf("export async function processRunnerRequest"));
  assert.ok(requestPath.indexOf("replayStore.claim") < requestPath.indexOf("openCredentialCapsule(envelope"));
  const result = await executeAdapter({ mode: "error" });
  assert.ok(result.error instanceof RunnerError);
  assert.equal(result.error.message.includes(CREDENTIAL), false);
  assert.equal(result.error.message.includes(PIECE_SUPERVISOR_SOCKET_PATH), false);
  assert.equal(result.fake.calls.length, 1);
});
