export const SANDBOX_PROTOCOL_VERSION = "crazyloops.piece-sandbox.v1";
export const SANDBOX_CAPABILITY_ID = "hubspot.get_contact";
export const SANDBOX_CAPABILITY_VERSION = "1";
export const SANDBOX_PIECE_ID = "@activepieces/piece-hubspot";
export const SANDBOX_PIECE_VERSION = "0.8.10";
export const SANDBOX_ACTION_ID = "get-contact";
export const SANDBOX_ALLOWED_DOMAINS = Object.freeze(["api.hubapi.com"]);
export const SANDBOX_MAX_REQUEST_BYTES = 32 * 1024;
export const SANDBOX_MAX_RESPONSE_BYTES = 128 * 1024;
export const SANDBOX_MAX_PROVIDER_BYTES = 64 * 1024;

export const SANDBOX_PROBE_MODES = Object.freeze([
  "normal",
  "state",
  "environment",
  "filesystem",
  "network",
  "redirect",
  "child_process",
  "pid_exhaustion",
  "temp_storage",
  "memory_exhaustion",
  "cpu_loop",
  "oversized_output",
  "malformed_output",
  "mismatched_request_id",
  "auth_401",
  "rate_429",
  "provider_400",
  "provider_500",
  "malformed_provider"
]);

export const PARENT_SENTINEL_NAMES = Object.freeze([
  "E50_DATABASE_SECRET",
  "E50_SUPABASE_SERVICE_SECRET",
  "E50_RUNNER_HMAC_SECRET",
  "E50_CREDENTIAL_WRAPPING_KEY",
  "E50_OTHER_CUSTOMER_CREDENTIAL"
]);
