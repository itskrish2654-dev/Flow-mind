import { createAdapterRegistry } from "/piece-runtime/src/adapter-registry.mjs";
import { createPieceBuildRegistry, HUBSPOT_0_8_10_BUILD } from "/piece-runtime/src/build-registry.mjs";
import { resolveManifestDestination } from "/piece-runtime/src/dns-policy.mjs";
import { createManifestRegistry, HUBSPOT_GET_CONTACT_MANIFEST } from "/piece-runtime/src/manifest-registry.mjs";
import { executeReviewedPiece } from "/piece-runtime/src/runtime.mjs";

function request() {
  return {
    protocolVersion: 1,
    requestId: "host-negative",
    executionId: "host-negative",
    capabilityId: "hubspot.get_contact",
    capabilityVersion: 1,
    mode: "TEST",
    idempotencyKey: "host-negative",
    input: { contactId: "contact" },
  };
}

function buildsFor(action) {
  return createPieceBuildRegistry([{
    ...HUBSPOT_0_8_10_BUILD,
    actions: { "get-contact": { classification: "READ", resolve: async () => action } },
  }]);
}

async function execute(action, manifest = HUBSPOT_GET_CONTACT_MANIFEST) {
  const builds = buildsFor(action);
  return executeReviewedPiece(
    { request: request(), credential: Buffer.from("synthetic-host-credential") },
    { builds, manifests: createManifestRegistry([manifest], builds), adapters: createAdapterRegistry() },
  );
}

const wrongClassification = await execute({ name: "get-contact", classification: "WRITE", run: async () => ({}) });
const oversized = await execute({
  name: "get-contact",
  classification: "READ",
  run: async () => ({ id: "contact", properties: { huge: "x".repeat(200_000) } }),
});
const timeoutManifest = structuredClone(HUBSPOT_GET_CONTACT_MANIFEST);
timeoutManifest.resourceLimits.executionTimeoutMs = 10;
const timeout = await execute({ name: "get-contact", classification: "READ", run: async () => new Promise(() => {}) }, timeoutManifest);
let unsafeDnsDenied = false;
try {
  await resolveManifestDestination(
    { hostname: "api.hubapi.com", port: 443, protocol: "tls" },
    { resolve4: async () => [{ address: "10.253.0.2", ttl: 60 }], resolve6: async () => [] },
  );
} catch { unsafeDnsDenied = true; }

const evidence = {
  wrongClassification: wrongClassification.errorCode,
  responseCeiling: oversized.errorCode,
  timeout: timeout.errorCode,
  unsafeDnsDenied,
};
process.stdout.write(`${JSON.stringify(evidence)}\n`);
if (
  evidence.wrongClassification !== "PIECE_ACTION_NOT_ALLOWED" ||
  evidence.responseCeiling !== "PIECE_RESPONSE_INVALID" ||
  evidence.timeout !== "PIECE_TIMEOUT" ||
  evidence.unsafeDnsDenied !== true
) process.exitCode = 1;
