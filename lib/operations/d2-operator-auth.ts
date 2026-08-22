import "@/lib/server-only-runtime";

import { createHash, timingSafeEqual } from "node:crypto";

const MIN_OPERATOR_SECRET_LENGTH = 32;

export type D2OperatorEnvironment = Record<string, string | undefined>;

function constantTimeTextEqual(expected: string, supplied: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function hasDedicatedSecret(
  environment: D2OperatorEnvironment,
  secretName: string,
  secret: string,
): boolean {
  return !Object.entries(environment).some(([name, value]) =>
    name !== secretName &&
    /(?:SECRET|KEY|TOKEN)/.test(name) &&
    Boolean(value) &&
    constantTimeTextEqual(secret, value ?? ""));
}

export function isD2OperatorAuthorized(input: {
  request: Request;
  environment: D2OperatorEnvironment;
  enabledName: string;
  secretName: string;
}): boolean {
  if (input.environment[input.enabledName] !== "true") return false;
  const secret = input.environment[input.secretName] ?? "";
  if (
    secret.length < MIN_OPERATOR_SECRET_LENGTH ||
    !hasDedicatedSecret(input.environment, input.secretName, secret)
  ) return false;
  const authorization = input.request.headers.get("authorization") ?? "";
  const supplied = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  return constantTimeTextEqual(secret, supplied);
}
