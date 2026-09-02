export const PIECE_ERROR_CODES = Object.freeze([
  "PIECE_UNSUPPORTED_CAPABILITY",
  "PIECE_INVALID_INPUT",
  "PIECE_INVALID_CREDENTIAL",
  "PIECE_ACTION_NOT_ALLOWED",
  "PIECE_AUTH_FAILED",
  "PIECE_RATE_LIMITED",
  "PIECE_PROVIDER_UNAVAILABLE",
  "PIECE_TIMEOUT",
  "PIECE_EGRESS_DENIED",
  "PIECE_RESPONSE_INVALID",
  "PIECE_RUNTIME_FAILED",
]);

export class PieceRuntimeError extends Error {
  constructor(code, retryable = false) {
    super("The reviewed piece operation could not be completed.");
    this.name = "PieceRuntimeError";
    this.code = PIECE_ERROR_CODES.includes(code) ? code : "PIECE_RUNTIME_FAILED";
    this.retryable = retryable === true;
  }
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function providerStatus(error) {
  const top = record(error);
  const response = record(top?.response);
  for (const value of [top?.status, top?.statusCode, response?.status]) {
    if (Number.isInteger(value)) return value;
  }
  if (Number.isInteger(top?.code) && top.code >= 100 && top.code <= 599) {
    return top.code;
  }
  return null;
}

export function normalizePieceFailure(error) {
  if (error instanceof PieceRuntimeError) return error;
  const status = providerStatus(error);
  if (status === 401 || status === 403) return new PieceRuntimeError("PIECE_AUTH_FAILED");
  if (status === 429) return new PieceRuntimeError("PIECE_RATE_LIMITED", true);
  if (status !== null && status >= 500) return new PieceRuntimeError("PIECE_PROVIDER_UNAVAILABLE", true);
  const code = record(error)?.code;
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "ABORT_ERR"].includes(String(code))) {
    return new PieceRuntimeError("PIECE_TIMEOUT", true);
  }
  if (["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"].includes(String(code))) {
    return new PieceRuntimeError("PIECE_EGRESS_DENIED");
  }
  return new PieceRuntimeError("PIECE_RUNTIME_FAILED");
}
