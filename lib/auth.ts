import "server-only";

import { createClient } from "@/lib/supabase/server";
import { resolveTrustedWorkspaceMembership } from "@/lib/workspace-context";

export async function getAuthenticatedContext() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) return null;
    const membership = await resolveTrustedWorkspaceMembership(user.id);
    return {
      supabase,
      user,
      workspace: { id: membership.workspaceId },
      membership,
    };
  } catch {
    return null;
  }
}
