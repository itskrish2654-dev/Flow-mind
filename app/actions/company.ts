"use server";

import { revalidatePath } from "next/cache";

import {
  acceptCompanyInvitation,
  createCompanyInvitation,
  removeCompanyMember,
  renameCurrentCompany,
  revokeCompanyInvitation,
  switchCurrentWorkspace,
  updateCompanyMemberRole,
} from "@/lib/company";

export type CompanyActionState = { ok: boolean; message?: string; inviteUrl?: string };
const failure = (error: unknown): CompanyActionState => ({ ok: false, message: error instanceof Error ? error.message : "The request could not be completed." });

export async function renameCompanyAction(_: CompanyActionState, formData: FormData): Promise<CompanyActionState> {
  try { await renameCurrentCompany(String(formData.get("name") ?? "")); revalidatePath("/settings/company"); return { ok: true, message: "Company name updated." }; } catch (error) { return failure(error); }
}

export async function createCompanyInvitationAction(_: CompanyActionState, formData: FormData): Promise<CompanyActionState> {
  try {
    const result = await createCompanyInvitation(String(formData.get("email") ?? ""), String(formData.get("role") ?? ""));
    revalidatePath("/settings/company");
    return { ok: true, message: "Invitation created. Copy this link now; it will not be shown again.", inviteUrl: result.inviteUrl };
  } catch (error) { return failure(error); }
}

export async function revokeCompanyInvitationAction(_: CompanyActionState, formData: FormData): Promise<CompanyActionState> {
  try { await revokeCompanyInvitation(String(formData.get("invitationId") ?? "")); revalidatePath("/settings/company"); return { ok: true, message: "Invitation revoked." }; } catch (error) { return failure(error); }
}

export async function changeCompanyMemberRoleAction(_: CompanyActionState, formData: FormData): Promise<CompanyActionState> {
  try { await updateCompanyMemberRole(String(formData.get("userId") ?? ""), String(formData.get("role") ?? "")); revalidatePath("/settings/company"); return { ok: true, message: "Member role updated." }; } catch (error) { return failure(error); }
}

export async function removeCompanyMemberAction(_: CompanyActionState, formData: FormData): Promise<CompanyActionState> {
  try { await removeCompanyMember(String(formData.get("userId") ?? "")); revalidatePath("/settings/company"); return { ok: true, message: "Member removed." }; } catch (error) { return failure(error); }
}

export async function switchWorkspaceAction(_: CompanyActionState, formData: FormData): Promise<CompanyActionState> {
  try { await switchCurrentWorkspace(String(formData.get("workspaceId") ?? "")); revalidatePath("/", "layout"); return { ok: true }; } catch (error) { return failure(error); }
}

export async function acceptCompanyInvitationAction(_: CompanyActionState, formData: FormData): Promise<CompanyActionState> {
  try { await acceptCompanyInvitation(String(formData.get("token") ?? "")); revalidatePath("/", "layout"); return { ok: true, message: "Invitation accepted." }; } catch (error) { return failure(error); }
}
