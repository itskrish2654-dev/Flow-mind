"use server";

import { z } from "zod";

import { getAuthenticatedContext } from "@/lib/auth";
import { GENERATED_DOCUMENTS_BUCKET } from "@/lib/document-storage";
import { createAdminClient } from "@/lib/supabase/admin";
import { securityLog } from "@/lib/security/redaction";

export const DOCUMENT_SIGNED_URL_TTL_SECONDS = 15 * 60;

export type SignedDocumentResult =
  | { ok: true; url: string; expiresInSeconds: number }
  | { ok: false; error: string };

export async function createDocumentDownloadUrl(
  documentId: string,
): Promise<SignedDocumentResult> {
  const parsed = z.string().uuid().safeParse(documentId);
  if (!parsed.success) return { ok: false, error: "Document not found." };
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("generated_document_records")
      .select("storage_path")
      .eq("id", parsed.data)
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (error || !data) return { ok: false, error: "Document not found." };

    const { data: signed, error: signedError } = await admin.storage
      .from(GENERATED_DOCUMENTS_BUCKET)
      .createSignedUrl(data.storage_path, DOCUMENT_SIGNED_URL_TTL_SECONDS);
    if (signedError || !signed?.signedUrl) {
      return { ok: false, error: "A secure download link could not be created." };
    }
    return {
      ok: true,
      url: signed.signedUrl,
      expiresInSeconds: DOCUMENT_SIGNED_URL_TTL_SECONDS,
    };
  } catch (error) {
    securityLog("Signed document URL failed", { error, documentId: parsed.data });
    return { ok: false, error: "A secure download link could not be created." };
  }
}
