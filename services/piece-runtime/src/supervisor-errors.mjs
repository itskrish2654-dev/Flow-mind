export const SUPERVISOR_ERROR_CODES = Object.freeze([
  "SUPERVISOR_INVALID_REQUEST",
  "SUPERVISOR_BUSY",
  "SUPERVISOR_DUPLICATE",
  "SUPERVISOR_UNAVAILABLE",
]);

export class SupervisorError extends Error {
  constructor(code, statusCode = 500) {
    super("The private piece supervisor could not complete the request.");
    this.name = "SupervisorError";
    this.code = SUPERVISOR_ERROR_CODES.includes(code) ? code : "SUPERVISOR_UNAVAILABLE";
    this.statusCode = Number.isInteger(statusCode) ? statusCode : 500;
  }
}

export function sanitizeSupervisorFailure(error) {
  if (error instanceof SupervisorError) return error;
  return new SupervisorError("SUPERVISOR_UNAVAILABLE", 503);
}
