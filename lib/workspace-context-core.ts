export type WorkspaceRole = "owner" | "admin" | "member";

export type TrustedWorkspaceMembership = Readonly<{
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  isDefault: true;
}>;

type WorkspaceBootstrapRow = Readonly<{
  workspace_id: string;
  membership_role: WorkspaceRole;
}>;

export function parseTrustedWorkspaceMembership(
  userId: string,
  rows: readonly WorkspaceBootstrapRow[] | null,
): TrustedWorkspaceMembership {
  if (!userId || !rows || rows.length !== 1) {
    throw new Error("Trusted workspace membership is unavailable.");
  }
  const row = rows[0];
  if (
    !row.workspace_id
    || !["owner", "admin", "member"].includes(row.membership_role)
  ) {
    throw new Error("Trusted workspace membership is invalid.");
  }
  return {
    workspaceId: row.workspace_id,
    userId,
    role: row.membership_role,
    isDefault: true,
  };
}
