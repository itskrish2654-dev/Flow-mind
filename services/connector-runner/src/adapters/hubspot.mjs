import {
  createPieceSupervisorClient,
  PieceSupervisorClientError,
} from "../piece-supervisor-client.mjs";

export const HUBSPOT_GET_CONTACT_CAPABILITY = "hubspot.get_contact";
export const HUBSPOT_GET_CONTACT_VERSION = 1;

const PIECE_TO_RUNNER_ERROR = Object.freeze({
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
});

function mapClientFailure(error, fail) {
  if (!(error instanceof PieceSupervisorClientError)) {
    fail("DELEGATED_EXECUTION_FAILED", false);
  }
  if (error.kind === "piece_failure") {
    const mapping = PIECE_TO_RUNNER_ERROR[error.pieceErrorCode];
    if (mapping) fail(mapping[0], mapping[1]);
    fail("DELEGATED_EXECUTION_FAILED", false);
  }
  if (["timeout", "aborted"].includes(error.kind)) fail("DELEGATED_TIMEOUT", true);
  if (["unavailable", "disconnected"].includes(error.kind)) fail("DELEGATED_UNAVAILABLE", true);
  if (["invalid_response", "response_too_large"].includes(error.kind)) fail("DELEGATED_BAD_RESPONSE", false);
  fail("DELEGATED_EXECUTION_FAILED", false);
}

/** @param {{fail: Function, supervisorClient?: {execute: Function}}} options */
export function createHubSpotGetContactAdapter({
  fail,
  supervisorClient = createPieceSupervisorClient(),
}) {
  if (typeof fail !== "function" || typeof supervisorClient?.execute !== "function") {
    throw new Error("HubSpot supervisor adapter configuration is invalid.");
  }
  return Object.freeze({
    async execute({
      requestId,
      executionId,
      capabilityId,
      capabilityVersion,
      mode,
      input,
      credential,
      idempotencyKey,
      signal,
    }) {
      if (
        capabilityId !== HUBSPOT_GET_CONTACT_CAPABILITY ||
        capabilityVersion !== HUBSPOT_GET_CONTACT_VERSION ||
        mode !== "TEST"
      ) {
        fail("DELEGATED_UNSUPPORTED_CAPABILITY", false);
      }
      try {
        const result = await supervisorClient.execute({
          request: {
            protocolVersion: 1,
            requestId,
            executionId,
            capabilityId,
            capabilityVersion,
            mode,
            idempotencyKey,
            input,
          },
          credential,
          signal,
        });
        return result.output;
      } catch (error) {
        mapClientFailure(error, fail);
      }
    },
  });
}

export const SUPERVISOR_ERROR_MAPPING = PIECE_TO_RUNNER_ERROR;
