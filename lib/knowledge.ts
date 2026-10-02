import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { getAuthenticatedContext } from "@/lib/auth";
import { KNOWLEDGE_LIMITS, knowledgeSearchQuery, safeKnowledgeFailure, soleOwnerWorkspaceWillBeRemoved, validateKnowledgeFile } from "@/lib/knowledge-core";
import { extractKnowledge } from "@/lib/knowledge-extraction";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/types";

export const KNOWLEDGE_BUCKET = "company_knowledge";
type Document = Database["public"]["Tables"]["knowledge_documents"]["Row"];
type Chunk = Database["public"]["Tables"]["knowledge_chunks"]["Row"];

function mustBeMember(auth: Awaited<ReturnType<typeof getAuthenticatedContext>>): asserts auth is NonNullable<typeof auth> {
  if (!auth) throw new Error("Sign in to access company knowledge.");
}

async function assertCurrentRole(workspaceId: string, userId: string, manage = false) {
  const { data, error } = await createAdminClient().from("workspace_memberships")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
  if (error || !data || (manage && data.role === "member")) {
    throw new Error("Company knowledge is unavailable to this account.");
  }
}

export async function listCompanyKnowledge(): Promise<{ documents: (Document & { processingStale: boolean })[]; canManage: boolean }> {
  const auth = await getAuthenticatedContext();
  mustBeMember(auth);
  await assertCurrentRole(auth.workspace.id, auth.user.id);
  const { data, error } = await auth.supabase.from("knowledge_documents")
    .select("id,workspace_id,uploaded_by_user_id,title,filename,mime_type,size_bytes,sha256,storage_path,status,page_count,character_count,chunk_count,failure_reason,created_at,updated_at")
    .eq("workspace_id", auth.workspace.id).order("created_at", { ascending: false })
    .limit(KNOWLEDGE_LIMITS.documentsPerWorkspace);
  if (error) throw new Error("Company knowledge could not be loaded.");
  const now = Date.now();
  return { documents: data.map((document) => ({ ...document,
    processingStale: document.status === "processing" && now - new Date(document.updated_at).getTime() > 120_000,
  })), canManage: auth.membership.role !== "member" };
}

export async function getCompanyKnowledgeDocument(documentId: string): Promise<{
  document: Document; chunks: Pick<Chunk, "id" | "chunk_index" | "page_number" | "content">[]; canManage: boolean;
} | null> {
  if (!z.uuid().safeParse(documentId).success) return null;
  const auth = await getAuthenticatedContext();
  mustBeMember(auth);
  await assertCurrentRole(auth.workspace.id, auth.user.id);
  const { data: document, error } = await auth.supabase.from("knowledge_documents")
    .select("id,workspace_id,uploaded_by_user_id,title,filename,mime_type,size_bytes,sha256,storage_path,status,page_count,character_count,chunk_count,failure_reason,created_at,updated_at")
    .eq("workspace_id", auth.workspace.id).eq("id", documentId).maybeSingle();
  if (error || !document) return null;
  const { data: chunks, error: chunkError } = document.status === "ready"
    ? await auth.supabase.from("knowledge_chunks")
        .select("id,chunk_index,page_number,content")
        .eq("workspace_id", auth.workspace.id).eq("document_id", documentId)
        .order("chunk_index", { ascending: true }).limit(KNOWLEDGE_LIMITS.chunks)
    : { data: [], error: null };
  if (chunkError) throw new Error("Company knowledge details are unavailable.");
  return { document, chunks: chunks ?? [], canManage: auth.membership.role !== "member" };
}

export async function uploadCompanyKnowledge(file: File): Promise<{ id: string; status: Document["status"] }> {
  const auth = await getAuthenticatedContext();
  mustBeMember(auth);
  await assertCurrentRole(auth.workspace.id, auth.user.id, true);
  if (!(file instanceof File) || file.size > KNOWLEDGE_LIMITS.fileBytes) {
    throw new Error("Choose a non-empty PDF, .txt, or .md file of 3 MB or less.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const validated = validateKnowledgeFile({ name: file.name, mime: file.type, bytes });
  const digest = createHash("sha256").update(bytes).digest("hex");
  const admin = createAdminClient();
  const { data: existing, error: existingError } = await admin.from("knowledge_documents")
    .select("id,status").eq("workspace_id", auth.workspace.id).eq("sha256", digest).maybeSingle();
  if (existingError) throw new Error("Company knowledge could not be checked.");
  if (existing) return { id: existing.id, status: existing.status };

  const id = randomUUID();
  const path = `${auth.workspace.id}/${id}/original.${validated.filename.split(".").at(-1)!.toLowerCase()}`;
  const { error: insertError } = await admin.from("knowledge_documents").insert({
    id, workspace_id: auth.workspace.id, uploaded_by_user_id: auth.user.id,
    title: validated.title, filename: validated.filename, mime_type: validated.mime,
    size_bytes: bytes.byteLength, sha256: digest, storage_path: path,
  });
  if (insertError) {
    const { data: concurrent } = await admin.from("knowledge_documents")
      .select("id,status").eq("workspace_id", auth.workspace.id).eq("sha256", digest).maybeSingle();
    if (concurrent) return { id: concurrent.id, status: concurrent.status };
    throw new Error(insertError.message.includes("limit")
      ? "This company already has 50 knowledge documents. Remove one before uploading another."
      : "Company knowledge could not be saved.");
  }

  let stored = false;
  let phase = "private_storage";
  try {
    const { error: storageError } = await admin.storage.from(KNOWLEDGE_BUCKET).upload(path, bytes, {
      contentType: validated.mime, upsert: false, cacheControl: "0",
    });
    if (storageError) throw new Error("Private document storage is unavailable.");
    stored = true;
    phase = "extraction";
    const extracted = await extractKnowledge(bytes, validated.mime);
    phase = "authorization";
    await assertCurrentRole(auth.workspace.id, auth.user.id, true);
    phase = "chunk_insert";
    const { error: chunksError } = await admin.from("knowledge_chunks").insert(extracted.chunks.map((chunk) => ({
      workspace_id: auth.workspace.id, document_id: id,
      chunk_index: chunk.chunkIndex, page_number: chunk.pageNumber, content: chunk.content,
    })));
    if (chunksError) throw new Error("Document indexing failed.");
    phase = "ready_update";
    const { data: ready, error: readyError } = await admin.from("knowledge_documents")
      .update({ status: "ready", page_count: extracted.pageCount,
        character_count: extracted.characterCount, chunk_count: extracted.chunks.length,
        updated_at: new Date().toISOString() })
      .eq("workspace_id", auth.workspace.id).eq("id", id).eq("status", "processing")
      .select("id").maybeSingle();
    if (readyError || !ready) throw new Error("Document indexing could not be finalized.");
    return { id, status: "ready" };
  } catch (error) {
    console.warn("Company knowledge indexing failed", { phase, category: error instanceof Error ? error.name : "unknown" });
    await admin.from("knowledge_chunks").delete().eq("workspace_id", auth.workspace.id).eq("document_id", id);
    const publicFailure = safeKnowledgeFailure(error);
    await admin.from("knowledge_documents").update({ status: "failed",
      failure_reason: publicFailure,
      updated_at: new Date().toISOString() })
      .eq("workspace_id", auth.workspace.id).eq("id", id).eq("status", "processing");
    if (stored) await admin.storage.from(KNOWLEDGE_BUCKET).remove([path]);
    throw new Error(publicFailure);
  }
}

export async function deleteCompanyKnowledge(documentId: string): Promise<void> {
  const auth = await getAuthenticatedContext();
  mustBeMember(auth);
  await assertCurrentRole(auth.workspace.id, auth.user.id, true);
  if (!z.uuid().safeParse(documentId).success) throw new Error("Document not found.");
  const admin = createAdminClient();
  const { data: document, error } = await admin.from("knowledge_documents")
    .select("id,storage_path").eq("workspace_id", auth.workspace.id).eq("id", documentId).maybeSingle();
  if (error) throw new Error("Document could not be checked.");
  if (!document) return;
  const { error: markError } = await admin.from("knowledge_documents")
    .update({ status: "deleting", updated_at: new Date().toISOString() })
    .eq("workspace_id", auth.workspace.id).eq("id", documentId);
  if (markError) throw new Error("Document could not be removed.");
  const { error: storageError } = await admin.storage.from(KNOWLEDGE_BUCKET).remove([document.storage_path]);
  if (storageError) throw new Error("Private file cleanup failed. Retry deletion.");
  const { error: deleteError } = await admin.from("knowledge_documents")
    .delete().eq("workspace_id", auth.workspace.id).eq("id", documentId).eq("status", "deleting");
  if (deleteError) throw new Error("Document metadata cleanup failed. Retry deletion.");
}

// Account deletion may remove a sole-owner workspace through cleanup_account_data.
// Remove its private objects before that RPC cascades the document rows that
// contain their paths. Shared workspaces with another member are untouched.
export async function cleanupCompanyKnowledgeForAccountDeletion(userId: string): Promise<void> {
  if (!z.uuid().safeParse(userId).success) throw new Error("Invalid account cleanup target.");
  const admin = createAdminClient();
  const { data: workspaces, error: workspaceError } = await admin.from("workspaces")
    .select("id").eq("created_by", userId).limit(100);
  if (workspaceError || !workspaces || workspaces.length === 100) throw new Error("Company knowledge cleanup inventory failed.");
  for (const workspace of workspaces) {
    const [{ data: otherMembers, error: memberError },
      { data: workflows, error: workflowError },
      { data: connections, error: connectionError }] = await Promise.all([
      admin.from("workspace_memberships").select("user_id").eq("workspace_id", workspace.id)
        .neq("user_id", userId).limit(1),
      admin.from("workflows").select("id,user_id").eq("workspace_id", workspace.id).limit(1000),
      admin.from("connector_connections").select("id").eq("workspace_id", workspace.id).limit(1),
    ]);
    if (memberError || workflowError || connectionError || !otherMembers || !workflows || !connections || workflows.length === 1000) {
      throw new Error("Company knowledge cleanup ownership check failed.");
    }
    if (!soleOwnerWorkspaceWillBeRemoved({ deletingUserId: userId,
      otherMemberCount: otherMembers.length,
      workflowOwnerIds: workflows.map((workflow) => workflow.user_id),
      remainingConnectionCount: connections.length,
    })) continue;
    const { data: documents, error: documentError } = await admin.from("knowledge_documents")
      .select("id,storage_path").eq("workspace_id", workspace.id).limit(KNOWLEDGE_LIMITS.documentsPerWorkspace + 1);
    if (documentError || !documents || documents.length > KNOWLEDGE_LIMITS.documentsPerWorkspace) {
      throw new Error("Company knowledge cleanup inventory failed.");
    }
    for (const document of documents) {
      const { error: markError } = await admin.from("knowledge_documents")
        .update({ status: "deleting", updated_at: new Date().toISOString() })
        .eq("workspace_id", workspace.id).eq("id", document.id);
      if (markError) throw new Error("Company knowledge cleanup failed.");
      const { error: storageError } = await admin.storage.from(KNOWLEDGE_BUCKET).remove([document.storage_path]);
      if (storageError) throw new Error("Company knowledge storage cleanup failed.");
      const { error: deleteError } = await admin.from("knowledge_documents")
        .delete().eq("workspace_id", workspace.id).eq("id", document.id).eq("status", "deleting");
      if (deleteError) throw new Error("Company knowledge cleanup failed.");
    }
  }
}

export async function searchCompanyKnowledge(input: { userId: string; workspaceId: string; question: string }) {
  const auth = await getAuthenticatedContext();
  mustBeMember(auth);
  if (auth.user.id !== input.userId || auth.workspace.id !== input.workspaceId) {
    throw new Error("Company knowledge is unavailable.");
  }
  const query = knowledgeSearchQuery(input.question);
  if (!query) return [];
  const { data, error } = await createAdminClient().rpc("search_company_knowledge", {
    p_actor_user_id: auth.user.id, p_workspace_id: auth.workspace.id,
    p_query: query, p_limit: 8,
  });
  if (error) throw new Error("Company knowledge search is unavailable.");
  return data;
}
