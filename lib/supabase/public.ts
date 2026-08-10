import "server-only";

import { createClient } from "@supabase/supabase-js";

import { boundedSupabaseFetch } from "@/lib/supabase/bounded-fetch";
import { getSupabaseConfig } from "@/lib/supabase/config";
import type { Database } from "@/lib/supabase/types";

export function createPublicClient() {
  const { url, key } = getSupabaseConfig();

  return createClient<Database>(url, key, {
    global: { fetch: boundedSupabaseFetch },
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
