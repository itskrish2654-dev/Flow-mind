"use server";

import { getAuthenticatedContext } from "@/lib/auth";

/** Presentation only. Every destination still enforces its own authorization. */
export async function getWorkspaceNavigationRole(): Promise<"owner" | "admin" | "member" | null> {
  const auth = await getAuthenticatedContext();
  return auth?.membership.role ?? null;
}
