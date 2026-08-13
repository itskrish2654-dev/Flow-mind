"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { revokeConnection } from "@/lib/connectors/connection-vault";
import { createClient } from "@/lib/supabase/server";

export async function disconnectConnector(connectionId: string) {
  const parsed = z.string().uuid().safeParse(connectionId);
  if (!parsed.success) return { ok: false as const, error: "Connection not found." };
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "Unauthorized" };
  try { await revokeConnection(user.id, parsed.data); revalidatePath("/settings/connections"); return { ok: true as const }; }
  catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "Connection could not be disconnected." }; }
}
