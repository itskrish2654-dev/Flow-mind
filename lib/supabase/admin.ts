import "server-only";

import { createClient } from "@supabase/supabase-js";

import { boundedSupabaseFetch } from "@/lib/supabase/bounded-fetch";
import { getSupabaseConfig } from "@/lib/supabase/config";
import type { Database } from "@/lib/supabase/types";

export function createAdminClient() {
  const { url } = getSupabaseConfig();
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!secretKey) {
    throw new Error("Missing SUPABASE_SECRET_KEY on the server.");
  }

  return createClient<Database>(url, secretKey, {
    global: { fetch: boundedSupabaseFetch },
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
