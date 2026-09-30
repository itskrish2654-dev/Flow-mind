import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const COMPANY_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const WorkspaceIdSchema = z.uuid();
export const InvitationIdSchema = z.uuid();
export const CompanyNameSchema = z.string().trim().min(1).max(120);
export const InvitationEmailSchema = z.email().max(320).transform((value) => value.trim().toLowerCase());
export const InvitationRoleSchema = z.enum(["admin", "member"]);
export const MemberRoleSchema = z.enum(["admin", "member"]);
export const InvitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export function generateInvitationToken() {
  return randomBytes(32).toString("base64url");
}
export function hashInvitationToken(token: string) {
  return createHash("sha256").update(InvitationTokenSchema.parse(token), "utf8").digest("hex");
}

export function canInvite(actorRole: "owner" | "admin" | "member", intendedRole: "admin" | "member") {
  return actorRole === "owner" || (actorRole === "admin" && intendedRole === "member");
}

export function canManageMember(
  actorRole: "owner" | "admin" | "member",
  targetRole: "owner" | "admin" | "member",
  action: "change_role" | "remove",
) {
  if (targetRole === "owner") return false;
  if (actorRole === "owner") return true;
  return actorRole === "admin" && targetRole === "member" && action === "remove";
}
