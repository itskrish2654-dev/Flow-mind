import "@/lib/server-only-runtime";

import { createHash, timingSafeEqual } from "node:crypto";

import { GOOGLE_IDENTITY_SCOPES, GOOGLE_SCOPES } from "@/lib/connectors/google/scopes";

export const GMAIL_LIVE_ACCEPTANCE_MARKER = "phase6b1d:gmail-live-acceptance" as const;

export const GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES = Object.freeze([
  ...GOOGLE_IDENTITY_SCOPES,
  GOOGLE_SCOPES.gmailReadonly,
  GOOGLE_SCOPES.gmailSend,
] as const);

export const GMAIL_LIVE_ACCEPTANCE_ENV_NAMES = Object.freeze([
  "PHASE6B1D_GMAIL_ACCEPTANCE_ENABLED",
  "PHASE6B1D_GMAIL_ACCEPTANCE_OPERATOR_SECRET",
  "PHASE6B1D_GMAIL_ACCEPTANCE_OWNER_ID",
  "PHASE6B1D_GMAIL_ACCEPTANCE_ACCOUNT_EMAIL",
  "PHASE6B1D_GMAIL_ACCEPTANCE_RECIPIENT_EMAIL",
  "PHASE6B1D_GMAIL_ACCEPTANCE_RUN_ID",
] as const);

const FORBIDDEN_SECRET_NAMES = Object.freeze([
  "CRON_SECRET",
  "SCHEDULE_DISPATCH_SECRET",
  "CONNECTOR_RUNNER_SECRET",
  "FLOWMIND_CREDENTIAL_MASTER_KEY",
  "FLOWMIND_RATE_LIMIT_SECRET",
  "SUPABASE_SECRET_KEY",
  "TURNSTILE_SECRET_KEY",
  "GOOGLE_OAUTH_CLIENT_SECRET",
] as const);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MIN_OPERATOR_SECRET_LENGTH = 32;

export type GmailLiveAcceptanceEnvironment = Record<string, string | undefined>;

export type GmailLiveAcceptanceConfig = Readonly<{
  enabled: true;
  ownerId: string;
  accountEmail: string;
  recipientEmail: string;
  runId: string;
  marker: typeof GMAIL_LIVE_ACCEPTANCE_MARKER;
  oauthScopes: typeof GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES;
}>;

export type GmailLiveAcceptancePolicy =
  | Readonly<{ status: "disabled"; config: null }>
  | Readonly<{ status: "invalid"; config: null }>
  | Readonly<{ status: "enabled"; config: GmailLiveAcceptanceConfig }>;

function constantTimeTextEqual(expected: string, supplied: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function normalizedEmail(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized || normalized.length > 320 || !EMAIL_PATTERN.test(normalized)) return null;
  return normalized;
}

function hasDedicatedOperatorSecret(
  environment: GmailLiveAcceptanceEnvironment,
  operatorSecret: string,
): boolean {
  return !FORBIDDEN_SECRET_NAMES.some((name) => {
    const configuredSecret = environment[name];
    return Boolean(configuredSecret) && constantTimeTextEqual(operatorSecret, configuredSecret ?? "");
  });
}

export function readGmailLiveAcceptancePolicy(
  environment: GmailLiveAcceptanceEnvironment = process.env,
): GmailLiveAcceptancePolicy {
  const enabledValue = environment.PHASE6B1D_GMAIL_ACCEPTANCE_ENABLED;
  if (enabledValue !== "true") return { status: "disabled", config: null };

  const operatorSecret = environment.PHASE6B1D_GMAIL_ACCEPTANCE_OPERATOR_SECRET ?? "";
  const ownerId = environment.PHASE6B1D_GMAIL_ACCEPTANCE_OWNER_ID ?? "";
  const runId = environment.PHASE6B1D_GMAIL_ACCEPTANCE_RUN_ID ?? "";
  const accountEmail = normalizedEmail(environment.PHASE6B1D_GMAIL_ACCEPTANCE_ACCOUNT_EMAIL);
  const recipientEmail = normalizedEmail(environment.PHASE6B1D_GMAIL_ACCEPTANCE_RECIPIENT_EMAIL);

  if (
    operatorSecret.length < MIN_OPERATOR_SECRET_LENGTH
    || /\s/.test(operatorSecret)
    || !hasDedicatedOperatorSecret(environment, operatorSecret)
    || !UUID_PATTERN.test(ownerId)
    || !UUID_PATTERN.test(runId)
    || !accountEmail
    || !recipientEmail
    || accountEmail === recipientEmail
  ) {
    return { status: "invalid", config: null };
  }

  return {
    status: "enabled",
    config: Object.freeze({
      enabled: true,
      ownerId: ownerId.toLowerCase(),
      accountEmail,
      recipientEmail,
      runId: runId.toLowerCase(),
      marker: GMAIL_LIVE_ACCEPTANCE_MARKER,
      oauthScopes: GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES,
    }),
  };
}

export function isGmailLiveAcceptanceOwner(
  userId: string,
  environment: GmailLiveAcceptanceEnvironment = process.env,
): boolean {
  const policy = readGmailLiveAcceptancePolicy(environment);
  return policy.status === "enabled"
    && constantTimeTextEqual(policy.config.ownerId, userId.trim().toLowerCase());
}

export function isGmailLiveAcceptanceMailbox(
  email: string,
  environment: GmailLiveAcceptanceEnvironment = process.env,
): boolean {
  const policy = readGmailLiveAcceptancePolicy(environment);
  const mailbox = normalizedEmail(email);
  return policy.status === "enabled"
    && mailbox !== null
    && constantTimeTextEqual(policy.config.accountEmail, mailbox);
}

export function isGmailLiveAcceptanceOperatorAuthorized(
  authorizationHeader: string | null | undefined,
  environment: GmailLiveAcceptanceEnvironment = process.env,
): boolean {
  const policy = readGmailLiveAcceptancePolicy(environment);
  if (policy.status !== "enabled") return false;
  const bearer = /^Bearer ([^\s]+)$/.exec(authorizationHeader ?? "")?.[1] ?? "";
  const operatorSecret = environment.PHASE6B1D_GMAIL_ACCEPTANCE_OPERATOR_SECRET ?? "";
  return constantTimeTextEqual(operatorSecret, bearer);
}

export function hasExactGmailLiveAcceptanceScopes(scopes: readonly string[]): boolean {
  const uniqueScopes = new Set(scopes);
  if (uniqueScopes.size !== scopes.length || uniqueScopes.size !== GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES.length) {
    return false;
  }
  return GMAIL_LIVE_ACCEPTANCE_OAUTH_SCOPES.every((scope) => uniqueScopes.has(scope));
}
