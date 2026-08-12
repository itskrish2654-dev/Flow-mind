import "server-only";

import { PLAN_ENTITLEMENTS, type UsageMetric } from "@/lib/security/limits";
import { createAdminClient } from "@/lib/supabase/admin";

export const DISPLAY_USAGE_METRICS: Array<{ metric: UsageMetric; label: string; monthly: boolean }> = [
  { metric: "workflows", label: "Workflows", monthly: false },
  { metric: "ai_generations", label: "AI generations", monthly: true },
  { metric: "executions", label: "Executions", monthly: true },
  { metric: "public_form_submissions", label: "Public submissions", monthly: true },
  { metric: "generated_documents", label: "Generated documents", monthly: true },
  { metric: "storage_bytes", label: "Document storage", monthly: false },
];

export type UsageItem = (typeof DISPLAY_USAGE_METRICS)[number] & {
  used: number;
  limit: number;
};

export async function getAccountUsage(userId: string): Promise<UsageItem[]> {
  const admin = createAdminClient();
  const period = new Date().toISOString().slice(0, 7) + "-01";
  const [{ data: counters, error: counterError }, workflowResult, documentResult] = await Promise.all([
    admin.from("usage_counters").select("metric, used").eq("user_id", userId).eq("period_started_at", period),
    admin.from("workflows").select("id", { count: "exact", head: true }).eq("user_id", userId).neq("lifecycle_state", "archived"),
    admin.from("generated_document_records").select("size_bytes").eq("user_id", userId),
  ]);
  if (counterError || workflowResult.error || documentResult.error) {
    throw new Error("usage_unavailable");
  }
  const values = new Map((counters ?? []).map((item) => [item.metric, Number(item.used)]));
  values.set("workflows", workflowResult.count ?? 0);
  values.set("storage_bytes", (documentResult.data ?? []).reduce((sum, item) => sum + Number(item.size_bytes), 0));

  return DISPLAY_USAGE_METRICS.map((item) => ({
    ...item,
    used: values.get(item.metric) ?? 0,
    limit: PLAN_ENTITLEMENTS.free[item.metric],
  }));
}
