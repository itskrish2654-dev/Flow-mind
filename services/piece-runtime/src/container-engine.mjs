import { createHash } from "node:crypto";

import { REVIEWED_PIECE_BUILDS } from "./build-registry.mjs";
import { deepFreeze } from "./deep-freeze.mjs";
import { EGRESS_BROKER_CONTAINER_NAME } from "./egress-broker-constants.mjs";
import { PieceRuntimeError } from "./errors.mjs";
import { REVIEWED_MANIFESTS } from "./manifest-registry.mjs";
import { validateInvocationRequest } from "./protocol.mjs";

function suffix(requestId) {
  return createHash("sha256").update(requestId).digest("hex").slice(0, 16);
}

export function validateResourceName(value) {
  return typeof value === "string" && /^cl-piece-[a-z]+-[a-f0-9]{16}$/.test(value);
}

export function buildInvocationPlan(requestValue, manifests = REVIEWED_MANIFESTS, builds = REVIEWED_PIECE_BUILDS) {
  const request = validateInvocationRequest(requestValue);
  const manifest = manifests.get(request.capabilityId, request.capabilityVersion);
  const build = builds.getForManifest(manifest);
  const id = suffix(request.requestId);
  const names = {
    sandbox: `cl-piece-sandbox-${id}`,
    internalNetwork: `cl-piece-internal-${id}`,
  };
  if (!Object.values(names).every(validateResourceName)) {
    throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
  }
  return deepFreeze({
    invocationId: id,
    names,
    labels: { "crazyloops.runtime": "piece-runtime-step5a", "crazyloops.invocation": id },
    manifestKey: `${manifest.capabilityId}@${manifest.capabilityVersion}`,
    buildId: build.buildId,
    images: {
      sandbox: build.sandboxImage,
    },
    broker: {
      containerName: EGRESS_BROKER_CONTAINER_NAME,
      controlRequired: true,
      credentialAccess: false,
      tlsTermination: false,
    },
    sandbox: {
      network: names.internalNetwork,
      internalOnlyNetwork: true,
      canonicalHostMappings: manifest.destinations.map((destination) => ({
        hostname: destination.hostname,
        target: "egress_broker_internal_ip",
      })),
      readOnlyRoot: true,
      tmpfs: "/tmp:rw,noexec,nosuid,nodev,size=4m",
      capDrop: ["ALL"],
      noNewPrivileges: true,
      pidsLimit: 16,
      memoryBytes: 128 * 1024 * 1024,
      memorySwapBytes: 128 * 1024 * 1024,
      cpus: 0.5,
      nofile: "64:64",
      user: "65532:65532",
      mounts: [],
      dockerSocket: false,
      logDriver: "none",
      stdinOnlyCredential: true,
    },
  });
}

export class PieceContainerEngine {
  /** @returns {Promise<unknown>} */
  async runInvocation(_input) {
    void _input;
    throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
  }

  async cleanupInvocation(_plan) {
    void _plan;
    throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
  }
}

export async function executeWithContainerEngine({ engine, request, credential, manifests = REVIEWED_MANIFESTS, builds = REVIEWED_PIECE_BUILDS }) {
  if (!(engine instanceof PieceContainerEngine)) throw new PieceRuntimeError("PIECE_RUNTIME_FAILED");
  const plan = buildInvocationPlan(request, manifests, builds);
  try {
    return await engine.runInvocation({ plan, request, credential });
  } finally {
    if (Buffer.isBuffer(credential)) credential.fill(0);
    await engine.cleanupInvocation(plan);
  }
}
