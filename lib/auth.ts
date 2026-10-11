import "server-only";
import { cache } from "react";

import { createClient } from "@/lib/supabase/server";
import { resolveTrustedWorkspaceMembership } from "@/lib/workspace-context";

// React memoizes only inside this server render. Never persist identity or
// membership across requests: actions and subsequent renders re-authorize.
export const getAuthenticatedContext = cache(async function getAuthenticatedContext() {
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
});
