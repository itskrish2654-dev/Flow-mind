import "server-only";

import { createClient } from "@supabase/supabase-js";

import { boundedSupabaseFetch } from "@/lib/supabase/bounded-fetch";
import { getSupabaseConfig } from "@/lib/supabase/config";
import type { Database } from "@/lib/supabase/types";

export function createAdminClient() {
  const { url } = getSupabaseConfig();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceRoleKey) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY on the server.");
  }

  return createClient<Database>(url, serviceRoleKey, {
    global: { fetch: boundedSupabaseFetch },
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
