import "server-only";

import { getAuthenticatedContext } from "@/lib/auth";
import {
  COMPANY_INVITE_TTL_MS,
  CompanyNameSchema,
  InvitationEmailSchema,
  InvitationIdSchema,
  InvitationRoleSchema,
  InvitationTokenSchema,
  MemberRoleSchema,
  WorkspaceIdSchema,
  generateInvitationToken,
  hashInvitationToken,
} from "@/lib/company-core";
import { getSiteUrl } from "@/lib/site-origin";
import { createAdminClient } from "@/lib/supabase/admin";

export type WorkspaceOption = {
  id: string;
  name: string;
  role: "owner" | "admin" | "member";
  active: boolean;
};

export type CompanyMember = {
  userId: string;
  email: string;
  displayName: string | null;
  role: "owner" | "admin" | "member";
  joinedAt: string;
  currentUser: boolean;
};

export type CompanyInvitation = {
  id: string;
  email: string;
  intendedRole: "admin" | "member";
  status: "pending" | "accepted" | "revoked" | "expired";
  createdAt: string;
  expiresAt: string;
};

function safeDisplayName(metadata: Record<string, unknown> | undefined) {
  const value = [metadata?.full_name, metadata?.name, metadata?.display_name]
    .find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return value?.trim().slice(0, 120) ?? null;
}

export async function listCurrentUserWorkspaces(): Promise<WorkspaceOption[]> {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const { data: memberships, error } = await auth.supabase.from("workspace_memberships")
    .select("workspace_id,role,is_default")
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: true });
  if (error || !memberships) throw new Error("Company workspaces could not be loaded.");
  const ids = memberships.map((membership) => membership.workspace_id);
  if (ids.length === 0) return [];
  const { data: workspaces, error: workspaceError } = await auth.supabase.from("workspaces")
    .select("id,name").in("id", ids);
  if (workspaceError || !workspaces) throw new Error("Company workspaces could not be loaded.");
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  return memberships.flatMap((membership) => {
    const name = names.get(membership.workspace_id);
    return name ? [{ id: membership.workspace_id, name, role: membership.role, active: membership.is_default }] : [];
  });
}

export async function switchCurrentWorkspace(workspaceId: string) {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const target = WorkspaceIdSchema.parse(workspaceId);
  const { data, error } = await createAdminClient().rpc("switch_active_workspace", {
    p_actor_user_id: auth.user.id,
    p_workspace_id: target,
  });
  if (error || !data?.[0]) throw new Error("That company workspace is not available to this account.");
  return data[0];
}

export async function getCompanyAdministration() {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  if (auth.membership.role === "member") throw new Error("Company administration is unavailable.");
  const admin = createAdminClient();
  const now = new Date().toISOString();
  await admin.from("workspace_invitations")
    .update({ status: "expired", updated_at: now })
    .eq("workspace_id", auth.workspace.id).eq("status", "pending").lte("expires_at", now);
  const [{ data: workspace, error: workspaceError }, { data: memberships, error: membershipError }, { data: invites, error: inviteError }] = await Promise.all([
    admin.from("workspaces").select("id,name").eq("id", auth.workspace.id).single(),
    admin.from("workspace_memberships").select("user_id,role,created_at")
      .eq("workspace_id", auth.workspace.id).order("created_at", { ascending: true }).limit(100),
    admin.from("workspace_invitations")
      .select("id,invited_email,intended_role,status,created_at,expires_at")
      .eq("workspace_id", auth.workspace.id).order("created_at", { ascending: false }).limit(100),
  ]);
  if (workspaceError || membershipError || inviteError || !workspace || !memberships || !invites) {
    throw new Error("Company administration could not be loaded.");
  }
  const members: CompanyMember[] = await Promise.all(memberships.map(async (membership) => {
    const { data } = await admin.auth.admin.getUserById(membership.user_id);
    const user = data.user;
    return {
      userId: membership.user_id,
      email: user?.email ?? "Account unavailable",
      displayName: safeDisplayName(user?.user_metadata),
      role: membership.role,
      joinedAt: membership.created_at,
      currentUser: membership.user_id === auth.user.id,
    };
  }));
  return {
    workspace,
    currentRole: auth.membership.role,
    members,
    invitations: invites.map((invite): CompanyInvitation => ({
      id: invite.id,
      email: invite.invited_email,
      intendedRole: invite.intended_role,
      status: invite.status,
      createdAt: invite.created_at,
      expiresAt: invite.expires_at,
    })),
  };
}

export async function renameCurrentCompany(name: string) {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const parsed = CompanyNameSchema.parse(name);
  const { error } = await createAdminClient().rpc("rename_company_workspace", {
    p_actor_user_id: auth.user.id,
    p_name: parsed,
    p_workspace_id: auth.workspace.id,
  });
  if (error) throw new Error("The company name could not be updated.");
}

export async function createCompanyInvitation(email: string, role: string) {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const normalizedEmail = InvitationEmailSchema.parse(email);
  const intendedRole = InvitationRoleSchema.parse(role);
  const admin = createAdminClient();
  const { data: memberships, error: membershipError } = await admin.from("workspace_memberships")
    .select("user_id").eq("workspace_id", auth.workspace.id).limit(100);
  if (membershipError || !memberships) throw new Error("Company membership could not be verified.");
  const memberEmails = await Promise.all(memberships.map(async (membership) => {
    const { data } = await admin.auth.admin.getUserById(membership.user_id);
    return data.user?.email?.trim().toLowerCase() ?? null;
  }));
  if (memberEmails.includes(normalizedEmail)) throw new Error("That account is already a company member.");
  const token = generateInvitationToken();
  const tokenHash = hashInvitationToken(token);
  const expiresAt = new Date(Date.now() + COMPANY_INVITE_TTL_MS).toISOString();
  const { data, error } = await admin.rpc("create_workspace_invitation", {
    p_actor_user_id: auth.user.id,
    p_expires_at: expiresAt,
    p_intended_role: intendedRole,
    p_invited_email: normalizedEmail,
    p_token_hash: tokenHash,
    p_workspace_id: auth.workspace.id,
  });
  if (error || !data?.[0]) throw new Error(error?.message === "account is already a member" ? "That account is already a company member." : "The invitation could not be created.");
  return {
    invitationId: data[0].id,
    inviteUrl: getSiteUrl(`/invite/accept?token=${encodeURIComponent(token)}`),
    expiresAt: data[0].expires_at,
  };
}

export async function revokeCompanyInvitation(invitationId: string) {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const { error } = await createAdminClient().rpc("revoke_workspace_invitation", {
    p_actor_user_id: auth.user.id,
    p_invitation_id: InvitationIdSchema.parse(invitationId),
  });
  if (error) throw new Error("The invitation could not be revoked.");
}

export async function updateCompanyMemberRole(targetUserId: string, role: string) {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const { error } = await createAdminClient().rpc("administer_workspace_member", {
    p_action: "change_role",
    p_actor_user_id: auth.user.id,
    p_role: MemberRoleSchema.parse(role),
    p_target_user_id: WorkspaceIdSchema.parse(targetUserId),
    p_workspace_id: auth.workspace.id,
  });
  if (error) throw new Error("The member role could not be changed.");
}

export async function removeCompanyMember(targetUserId: string) {
  const auth = await getAuthenticatedContext();
  if (!auth) throw new Error("Unauthorized");
  const { error } = await createAdminClient().rpc("administer_workspace_member", {
    p_action: "remove",
    p_actor_user_id: auth.user.id,
    p_role: null,
    p_target_user_id: WorkspaceIdSchema.parse(targetUserId),
    p_workspace_id: auth.workspace.id,
  });
  if (error) throw new Error("The member could not be removed.");
}

export async function previewCompanyInvitation(token: string) {
  let hash: string;
  try { hash = hashInvitationToken(InvitationTokenSchema.parse(token)); } catch { return { status: "unavailable" as const }; }
  const admin = createAdminClient();
  const { data, error } = await admin.from("workspace_invitations")
    .select("workspace_id,status,expires_at,accepted_by").eq("token_hash", hash).maybeSingle();
  if (error || !data) return { status: "unavailable" as const };
  let status = data.status;
  if (status === "pending" && new Date(data.expires_at).getTime() <= Date.now()) {
    const expiredAt = new Date().toISOString();
    const { error: expirationError } = await admin.from("workspace_invitations")
      .update({ status: "expired", updated_at: expiredAt })
      .eq("token_hash", hash).eq("status", "pending").lte("expires_at", expiredAt);
    if (expirationError) return { status: "unavailable" as const };
    status = "expired";
  }
  const { data: workspace } = await admin.from("workspaces").select("name").eq("id", data.workspace_id).maybeSingle();
  return { status, workspaceName: workspace?.name ?? "this company" } as const;
}

export async function acceptCompanyInvitation(token: string) {
  const auth = await getAuthenticatedContext();
  if (!auth || !auth.user.email) throw new Error("Authentication is required.");
  const { data, error } = await createAdminClient().rpc("accept_workspace_invitation", {
    p_actor_email: auth.user.email.trim().toLowerCase(),
    p_actor_user_id: auth.user.id,
    p_token_hash: hashInvitationToken(InvitationTokenSchema.parse(token)),
  });
  if (!error && data?.[0]?.acceptance_outcome === "expired") throw new Error("This invitation has expired.");
  if (error || !data?.[0]) {
    const message = error?.message ?? "";
    if (message.includes("account mismatch")) throw new Error("This invitation belongs to a different account. Sign in with the invited email address.");
    if (message.includes("expired")) throw new Error("This invitation has expired.");
    throw new Error("This invitation is no longer available.");
  }
  return data[0];
}
