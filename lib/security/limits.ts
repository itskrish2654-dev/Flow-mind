import "server-only";

import { createHmac, randomUUID } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";

export class SecurityGateError extends Error {
  constructor(
    message: string,
    public readonly code: "RATE_LIMITED" | "QUOTA_EXCEEDED" | "BUSY" | "UNAVAILABLE",
  ) {
    super(message);
    this.name = "SecurityGateError";
  }
}

export const SECURITY_LIMITS = {
  signup: { limit: 5, windowSeconds: 3_600 },
  login: { limit: 10, windowSeconds: 15 * 60 },
  recovery: { limit: 5, windowSeconds: 3_600 },
  planning: { limit: 12, windowSeconds: 60 },
  ai: { limit: 10, windowSeconds: 60 },
  customization: { limit: 8, windowSeconds: 60 },
  testExecution: { limit: 12, windowSeconds: 60 },
  publicFormIp: { limit: 10, windowSeconds: 60 },
  publicFormWorkflow: { limit: 30, windowSeconds: 60 },
  publicFormDuplicate: { limit: 1, windowSeconds: 60 },
  pdf: { limit: 10, windowSeconds: 60 },
  webhookUser: { limit: 10, windowSeconds: 60 },
  webhookDestination: { limit: 20, windowSeconds: 60 },
} as const;

export type UsageMetric =
  | "workflows"
  | "ai_generations"
  | "ai_input_chars"
  | "ai_output_tokens"
  | "executions"
  | "public_form_submissions"
  | "generated_documents"
  | "uploads"
  | "storage_bytes";

export type PlanName = "free" | "pro" | "business";

export const PLAN_ENTITLEMENTS: Record<PlanName, Record<UsageMetric, number>> = {
  free: {
    workflows: 25,
    ai_generations: 100,
    ai_input_chars: 1_000_000,
    ai_output_tokens: 100_000,
    executions: 500,
    public_form_submissions: 300,
    generated_documents: 100,
    uploads: 100,
    storage_bytes: 50 * 1024 * 1024,
  },
  pro: {
    workflows: 250,
    ai_generations: 2_000,
    ai_input_chars: 20_000_000,
    ai_output_tokens: 2_000_000,
    executions: 10_000,
    public_form_submissions: 8_000,
    generated_documents: 2_000,
    uploads: 2_000,
    storage_bytes: 2 * 1024 * 1024 * 1024,
  },
  business: {
    workflows: 2_000,
    ai_generations: 25_000,
    ai_input_chars: 250_000_000,
    ai_output_tokens: 25_000_000,
    executions: 100_000,
    public_form_submissions: 80_000,
    generated_documents: 25_000,
    uploads: 25_000,
    storage_bytes: 20 * 1024 * 1024 * 1024,
  },
};

function gateSecret(): string {
  const value =
    process.env.FLOWMIND_RATE_LIMIT_SECRET ??
    process.env.FLOWMIND_CREDENTIAL_MASTER_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) throw new SecurityGateError("Security controls are unavailable.", "UNAVAILABLE");
  return value;
}

export function securityKey(namespace: string, parts: string[]): string {
  return createHmac("sha256", gateSecret())
    .update([namespace, ...parts].join("\u001f"))
    .digest("hex");
}

export async function enforceRateLimit(
  namespace: string,
  parts: string[],
  rule: { limit: number; windowSeconds: number },
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("consume_security_rate_limit", {
      p_key_hash: securityKey(namespace, parts),
      p_limit: rule.limit,
      p_window_seconds: rule.windowSeconds,
    });
    if (error || !data?.[0]) throw new Error("rate backend failed");
    if (!data[0].allowed) {
      throw new SecurityGateError("Too many requests. Try again shortly.", "RATE_LIMITED");
    }
  } catch (error) {
    if (error instanceof SecurityGateError) throw error;
    throw new SecurityGateError("This request cannot be accepted safely right now.", "UNAVAILABLE");
  }
}

export async function enforceUsageQuota(
  userId: string,
  metric: UsageMetric,
  amount = 1,
  plan: PlanName = "free",
): Promise<void> {
  try {
    const admin = createAdminClient();
    const period = new Date().toISOString().slice(0, 7) + "-01";
    const { data, error } = await admin.rpc("consume_usage_quota", {
      p_user_id: userId,
      p_metric: metric,
      p_amount: amount,
      p_limit: PLAN_ENTITLEMENTS[plan][metric],
      p_period_started_at: period,
    });
    if (error || !data?.[0]) throw new Error("quota backend failed");
    if (!data[0].allowed) {
      throw new SecurityGateError("This account has reached its current usage limit.", "QUOTA_EXCEEDED");
    }
  } catch (error) {
    if (error instanceof SecurityGateError) throw error;
    throw new SecurityGateError("This request cannot be accepted safely right now.", "UNAVAILABLE");
  }
}

export async function withConcurrencyLease<T>(
  namespace: string,
  parts: string[],
  limit: number,
  work: () => Promise<T>,
  ttlSeconds = 120,
): Promise<T> {
  const admin = createAdminClient();
  const keyHash = securityKey(namespace, parts);
  const leaseId = randomUUID();
  try {
    const { data, error } = await admin.rpc("acquire_security_concurrency", {
      p_key_hash: keyHash,
      p_lease_id: leaseId,
      p_limit: limit,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) throw new SecurityGateError("This request cannot be accepted safely right now.", "UNAVAILABLE");
    if (!data) throw new SecurityGateError("This automation is already busy. Try again shortly.", "BUSY");
    return await work();
  } finally {
    await admin.rpc("release_security_concurrency", {
      p_key_hash: keyHash,
      p_lease_id: leaseId,
    });
  }
}
