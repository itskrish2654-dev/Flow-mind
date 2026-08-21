import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBridgeSignature } from "../lib/executors/activepieces";
import {
  createDelegatedCredentialCapsule,
  loadDelegatedWrapKeyRingFromEnvironment,
  type DelegatedCapsuleBinding,
} from "../lib/executors/delegated-capsule";

const confirmation = "RUN_FAKE_D15_CANARY_ONLY";
if (process.env.D15_CANARY_CONFIRM !== confirmation) {
  throw new Error(`Set D15_CANARY_CONFIRM=${confirmation} to run the disposable canary.`);
}

const configuredUrl = process.env.D15_CANARY_BRIDGE_URL;
const bridgeSecret = process.env.ACTIVEPIECES_BRIDGE_SECRET ?? "";
let url: URL;
try {
  url = new URL(configuredUrl ?? "");
} catch {
  throw new Error("D15_CANARY_BRIDGE_URL must be the HTTPS URL of the isolated v2 canary flow.");
}
if (url.protocol !== "https:" || url.username || url.password || bridgeSecret.length < 32) {
  throw new Error("The isolated canary URL or bridge authentication is not configured safely.");
}
if (configuredUrl === process.env.ACTIVEPIECES_BRIDGE_URL) {
  throw new Error("D1.5 must use a separate disposable v2 flow, not the accepted v1 bridge URL.");
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 64 * 1024) {
      await reader.cancel();
      throw new Error("The canary response exceeded the bridge response limit.");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

const now = Date.now();
const binding: DelegatedCapsuleBinding = {
  protocolVersion: 2,
  requestId: randomUUID(),
  executionId: randomUUID(),
  workflowVersionId: randomUUID(),
  stepId: "d15_canary_adapter",
  capabilityId: "internal.credential_canary",
  capabilityVersion: 1,
};
const canary = `CRAZYLOOPS_CANARY_${randomBytes(32).toString("hex")}`;
const credentialCapsule = createDelegatedCredentialCapsule({
  credential: canary,
  binding,
  keyRing: loadDelegatedWrapKeyRingFromEnvironment(),
  now,
});
const envelope = {
  ...binding,
  mode: "TEST",
  idempotencyKey: `${binding.executionId}:${binding.stepId}:v2`,
  input: { operation: "canary_digest" },
  credentialCapsule,
};
const body = JSON.stringify(envelope);
if (body.includes(canary)) throw new Error("Canary plaintext entered the serialized envelope.");
const canaryFile = join(tmpdir(), `crazyloops-d15-canary-${binding.requestId}.txt`);
await writeFile(canaryFile, `${canary}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });

const bodyDigest = createHash("sha256").update(body).digest("hex");
const timestamp = String(now);
const signature = createBridgeSignature({
  secret: bridgeSecret,
  timestamp,
  requestId: binding.requestId,
  bodyDigest,
});
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);
let response: Response;
try {
  response = await fetch(url, {
    method: "POST",
    redirect: "manual",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      "X-CrazyLoops-Timestamp": timestamp,
      "X-CrazyLoops-Request-Id": binding.requestId,
      "X-CrazyLoops-Content-SHA256": bodyDigest,
      "X-CrazyLoops-Signature": `v2=${signature}`,
    },
    body,
  });
} finally {
  clearTimeout(timeout);
}

const responseText = await readBoundedResponse(response);
const responseOccurrences = responseText.split(canary).length - 1;
let validResponse = false;
try {
  const parsed = JSON.parse(responseText) as Record<string, unknown>;
  const output = parsed.output as Record<string, unknown> | undefined;
  validResponse = parsed.ok === true &&
    parsed.protocolVersion === 2 &&
    parsed.requestId === binding.requestId &&
    parsed.acknowledged === true &&
    typeof output?.proof === "string" &&
    /^[a-f0-9]{64}$/.test(output.proof);
} catch {
  validResponse = false;
}

console.log(JSON.stringify({
  requestId: binding.requestId,
  status: response.status,
  responseOk: response.ok,
  validResponse,
  canaryFile,
  plaintextCanaryOccurrencesInRequest: 0,
  plaintextCanaryOccurrencesInResponse: responseOccurrences,
}));

if (!response.ok || !validResponse || responseOccurrences !== 0) process.exitCode = 1;
