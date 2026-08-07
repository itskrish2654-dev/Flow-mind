import "server-only";

import { createClient } from "@/lib/supabase/server";

export async function getAuthenticatedContext() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) return null;
    return { supabase, user };
  } catch {
    return null;
  }
}
