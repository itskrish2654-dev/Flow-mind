import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

export const GENERATED_DOCUMENTS_BUCKET = "generated_documents";

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
}

export async function uploadGeneratedDocument(
  supabase: SupabaseClient<Database>,
  ownerId: string,
  workflowId: string,
  bytes: Uint8Array,
  stableKey?: string,
): Promise<{ id: string; path: string; filename: string }> {
  const filename = stableKey
    ? `${safeFilePart(workflowId)}_${safeFilePart(stableKey)}.pdf`
    : `${safeFilePart(workflowId)}_${Date.now()}_${crypto.randomUUID()}.pdf`;
  const path = `${ownerId}/${workflowId}/${filename}`;
  const { error } = await supabase.storage
    .from(GENERATED_DOCUMENTS_BUCKET)
    .upload(path, bytes, {
      cacheControl: "3600",
      contentType: "application/pdf",
      upsert: false,
    });

  if (error?.message.toLowerCase().includes("already exists") && stableKey) {
    const { data: existing } = await supabase
      .from("generated_document_records")
      .select("id, filename")
      .eq("user_id", ownerId)
      .eq("workflow_id", workflowId)
      .eq("storage_path", path)
      .maybeSingle();
    if (existing) return { id: existing.id, path, filename: existing.filename };
  }
  if (error) throw new Error(`Document upload failed: ${error.message}`);

  const { data: record, error: recordError } = await supabase
    .from("generated_document_records")
    .insert({
      user_id: ownerId,
      workflow_id: workflowId,
      storage_path: path,
      filename,
      size_bytes: bytes.byteLength,
    })
    .select("id")
    .single();

  if (recordError || !record) {
    await supabase.storage.from(GENERATED_DOCUMENTS_BUCKET).remove([path]);
    throw new Error("Document metadata could not be saved.");
  }

  return { id: record.id, path, filename };
}
