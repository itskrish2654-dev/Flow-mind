import "@/lib/server-only-runtime";

import { createAdminClient } from "@/lib/supabase/admin";
import { trackProductEvent } from "@/lib/observability";
import {
  parseTrustedWorkspaceMembership,
  type TrustedWorkspaceMembership,
} from "@/lib/workspace-context-core";

export {
  parseTrustedWorkspaceMembership,
  type TrustedWorkspaceMembership,
  type WorkspaceRole,
} from "@/lib/workspace-context-core";

/**
 * Resolve the only trusted workspace for an authenticated user. The service-only
 * RPC lazily bootstraps new accounts and fails closed for missing or ambiguous
 * default membership. No browser-provided workspace identifier is accepted.
 */
export async function resolveTrustedWorkspaceMembership(
  userId: string,
): Promise<TrustedWorkspaceMembership> {
  const { data, error } = await createAdminClient().rpc(
    "ensure_default_workspace",
    { p_user_id: userId },
  );
  if (error) throw new Error("Trusted workspace membership is unavailable.");
  return parseTrustedWorkspaceMembership(userId, data);
}

/** Called only after first sign-up/confirmation, not on every authenticated request. */
export async function recordNewAccountWorkspace(userId: string): Promise<void> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("workspace_memberships")
    .select("workspace_id").eq("user_id", userId).limit(1);
  if (error || !data || data.length > 0) return;
  await resolveTrustedWorkspaceMembership(userId);
  await trackProductEvent({ event: "workspace_created", userId });
}
