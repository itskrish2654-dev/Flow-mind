import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  normalizeTelemetryRequestId,
  normalizeTelemetryUuid,
} from "../lib/telemetry-identifiers";

const EXECUTION_ID = "9f7fc39e-7e23-498f-8f5a-d18a6f3c1990";
const WORKFLOW_ID = "609198f7-c9b8-4f11-a8e3-9a040fb16516";
const VERSION_ID = "44bcdbea-4c8d-47bc-9a16-47d5cedd43b0";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("9C.2-A. valid UUID-backed telemetry identifiers retain their real relations", () => {
  assert.equal(normalizeTelemetryUuid(EXECUTION_ID), EXECUTION_ID);
  assert.equal(normalizeTelemetryUuid(WORKFLOW_ID), WORKFLOW_ID);
  assert.equal(normalizeTelemetryUuid(VERSION_ID), VERSION_ID);
});

test("9C.2-B. absent optional execution identifiers persist as NULL", () => {
  assert.equal(normalizeTelemetryUuid(null), null);
  assert.equal(normalizeTelemetryUuid(undefined), null);
  assert.equal(normalizeTelemetryUuid(""), null);
});

test("9C.2-C. manual correlation identifiers never masquerade as execution relations", () => {
  assert.equal(normalizeTelemetryUuid(`manual:${EXECUTION_ID}`), null);
  assert.equal(normalizeTelemetryUuid(`test:${EXECUTION_ID}`), null);
  assert.equal(normalizeTelemetryUuid(`preview:${EXECUTION_ID}`), null);
  assert.equal(normalizeTelemetryUuid(`anonymous:${EXECUTION_ID}`), null);
});

test("9C.2-D. malformed strings cannot enter UUID database columns", () => {
  for (const value of ["not-a-uuid", " 9f7fc39e-7e23-498f-8f5a-d18a6f3c1990", "9f7fc39e7e23498f8f5ad18a6f3c1990", "../../secret"])
    assert.equal(normalizeTelemetryUuid(value), null);
});

test("9C.2-E. manual HTTP success events share the safe normalized telemetry boundary", async () => {
  const [runtime, observability] = await Promise.all([
    source("lib/http-request-runtime.ts"),
    source("lib/observability.ts"),
  ]);
  assert.match(runtime, /event:\s*"http_request_started"/);
  assert.match(runtime, /event:\s*"http_request_succeeded"/);
  assert.equal(normalizeTelemetryUuid(`manual:${EXECUTION_ID}`), null);
  assert.match(observability, /execution_id:\s*normalizeTelemetryUuid\(event\.executionId\)/);
  assert.match(observability, /execution_id:\s*payload\.execution_id/);
});

test("9C.2-F. manual HTTP failure retains its normalized error without UUID contamination", async () => {
  const runtime = await source("lib/http-request-runtime.ts");
  assert.match(runtime, /event:\s*"http_request_failed"/);
  assert.match(runtime, /errorCategory:\s*error\.code/);
  assert.match(runtime, /metadata:\s*\{ method, retryable: error\.retryable \}/);
  assert.equal(normalizeTelemetryUuid(`manual:${EXECUTION_ID}`), null);
});

test("9C.2-G/H. LIVE and TEST paths forward genuine durable execution UUIDs separately from idempotency", async () => {
  const [runtime, manual, publicForm, scheduled, connectorDispatch] = await Promise.all([
    source("lib/workflow-execution.ts"),
    source("app/actions/execute.ts"),
    source("app/f/[projectId]/actions.ts"),
    source("lib/scheduled-workflows.ts"),
    source("lib/connectors/webhook-dispatch.ts"),
  ]);
  assert.match(runtime, /executionId:\s*telemetryExecutionId \?\? idempotencyKey \?\? workflowId/);
  assert.match(manual, /idempotencyKey:\s*createManualIdempotencyKey[\s\S]{0,120}telemetryExecutionId:\s*durable\.id/);
  assert.match(manual, /idempotencyKey:\s*existing\.idempotency_key[\s\S]{0,120}telemetryExecutionId:\s*existing\.id/);
  assert.match(publicForm, /idempotencyKey,[\s\S]{0,80}telemetryExecutionId:\s*durable\.id/);
  assert.match(scheduled, /idempotencyKey,[\s\S]{0,80}telemetryExecutionId:\s*durable\.id/);
  assert.match(connectorDispatch, /telemetryExecutionId:\s*durable\.id/);
});

test("9C.2-I. genuine telemetry persistence failures remain observable", async () => {
  const observability = await source("lib/observability.ts");
  const failureSignals = observability.match(/event:\s*"telemetry_persistence_failed"/g) ?? [];
  assert.equal(failureSignals.length, 2);
  assert.match(observability, /if \(error\) console\.error/);
  assert.match(observability, /catch \{\s*console\.error/);
});

test("9C.2-J. request correlation is bounded opaque text and event IDs are generated UUIDs", async () => {
  assert.equal(normalizeTelemetryRequestId(`manual:${EXECUTION_ID}`), `manual:${EXECUTION_ID}`);
  assert.equal(normalizeTelemetryRequestId("x".repeat(101)), null);
  assert.equal(normalizeTelemetryRequestId("contains a space"), null);
  const observability = await source("lib/observability.ts");
  assert.match(observability, /const eventId = randomUUID\(\)/);
  assert.match(observability, /request_id:\s*normalizeTelemetryRequestId\(event\.requestId\)/);
});

test("9C.2-K. HTTP telemetry remains metadata-only and contains no request or response bodies", async () => {
  const runtime = await source("lib/http-request-runtime.ts");
  assert.doesNotMatch(runtime, /metadata:\s*\{[^}]*\b(?:url|body|query|headers|secret|authorization)\b/);
  assert.doesNotMatch(runtime, /captureOperationalEvent\([\s\S]{0,500}(?:Authorization|Bearer|Basic|api[_-]?key)/i);
});

test("9C.2-L. operational UUID columns retain their relational database types without migration", async () => {
  const migration = await source("supabase/migrations/20260813000100_phase6_operations.sql");
  assert.match(migration, /id uuid primary key/);
  assert.match(migration, /request_id text check \(request_id is null or char_length\(request_id\) <= 100\)/);
  assert.match(migration, /workflow_id uuid/);
  assert.match(migration, /workflow_version_id uuid/);
  assert.match(migration, /execution_id uuid/);
});

