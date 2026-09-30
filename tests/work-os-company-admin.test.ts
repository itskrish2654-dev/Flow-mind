import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { safeAuthReturnPath } from "../lib/auth-return-path";
import {
  COMPANY_INVITE_TTL_MS,
  canInvite,
  canManageMember,
  generateInvitationToken,
  hashInvitationToken,
} from "../lib/company-core";

const migration = "supabase/migrations/20260930100353_work_os_company_admin_v1.sql";
const qualificationMigration = "supabase/migrations/20260930121557_work_os_company_admin_rpc_qualification.sql";
const authBoundaryMigration = "supabase/migrations/20260930122157_work_os_company_invite_auth_boundary.sql";
const acceptQualificationMigration = "supabase/migrations/20260930180412_work_os_company_accept_rpc_qualification.sql";
const defaultQualificationMigration = "supabase/migrations/20260930181631_work_os_company_default_workspace_qualification.sql";
const invitationIndexesMigration = "supabase/migrations/20260930181700_work_os_company_invitation_fk_indexes.sql";

test("invitation credentials use 256-bit randomness and one-way fixed-length hashes", () => {
  const first = generateInvitationToken();
  const second = generateInvitationToken();
  assert.equal(first.length, 43);
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.match(hashInvitationToken(first), /^[0-9a-f]{64}$/);
  assert.notEqual(hashInvitationToken(first), first);
  assert.equal(COMPANY_INVITE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test("owner/admin/member permission matrix is narrow", () => {
  assert.equal(canInvite("owner", "admin"), true);
  assert.equal(canInvite("owner", "member"), true);
  assert.equal(canInvite("admin", "member"), true);
  assert.equal(canInvite("admin", "admin"), false);
  assert.equal(canInvite("member", "member"), false);
  assert.equal(canManageMember("owner", "admin", "change_role"), true);
  assert.equal(canManageMember("owner", "member", "remove"), true);
  assert.equal(canManageMember("admin", "member", "remove"), true);
  assert.equal(canManageMember("admin", "member", "change_role"), false);
  assert.equal(canManageMember("admin", "admin", "remove"), false);
  assert.equal(canManageMember("owner", "owner", "remove"), false);
  assert.equal(canManageMember("member", "member", "remove"), false);
});

test("authentication continuation permits only known internal destinations", () => {
  const invite = "/invite/accept?token=" + "a".repeat(43);
  assert.equal(safeAuthReturnPath(invite), invite);
  assert.equal(safeAuthReturnPath("/settings/company"), "/settings/company");
  assert.equal(safeAuthReturnPath("https://evil.example/invite/accept?token=x"), "/dashboard");
  assert.equal(safeAuthReturnPath("//evil.example/path"), "/dashboard");
  assert.equal(safeAuthReturnPath("/invite/accept"), "/dashboard");
  assert.equal(safeAuthReturnPath("/invite/accept?token=x#leak"), "/dashboard");
});

test("migration keeps invitation material service-only with explicit RLS and grants", async () => {
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;\s*$/);
  assert.match(sql, /create table public\.workspace_invitations/);
  assert.match(sql, /token_hash text not null unique/);
  assert.match(sql, /token_hash ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /force row level security/);
  assert.match(sql, /revoke all on table public\.workspace_invitations from public, anon, authenticated/);
  assert.match(sql, /grant select, insert, update, delete on table public\.workspace_invitations to service_role/);
  assert.doesNotMatch(sql, /create policy[\s\S]*workspace_invitations/i);
  assert.equal(sql.includes("grant select on table public.workspace_invitations to authenticated"), false);
});

test("database functions enforce active membership, role boundaries, email binding, and replay safety", async () => {
  const sql = await readFile(migration, "utf8");
  assert.doesNotMatch(sql, /security definer/i);
  assert.match(sql, /create function public\.switch_active_workspace/);
  assert.match(sql, /where workspace_id = p_workspace_id and user_id = p_actor_user_id for update/);
  assert.match(sql, /create unique index workspace_invitations_one_pending_per_email/);
  assert.match(sql, /hashtextextended\('workspace-invite-token:' \|\| p_token_hash/);
  assert.match(sql, /v_invite\.normalized_email <> v_email/);
  assert.match(sql, /on conflict \(workspace_id, user_id\) do nothing/);
  assert.match(sql, /v_invite\.accepted_by <> p_actor_user_id/);
  assert.match(sql, /p_intended_role <> 'member'/);
  assert.match(sql, /v_target_role = 'owner'/);
  assert.match(sql, /v_actor_role = 'admin' and v_target_role <> 'member'/);
  assert.match(sql, /delete from public\.workflows where workspace_id = p_workspace_id and user_id = p_target_user_id/);
  assert.match(sql, /delete from public\.workspace_memberships where workspace_id = p_workspace_id and user_id = p_target_user_id/);
  assert.match(sql, /if current_user <> 'service_role'/g);
  assert.match(sql, /revoke all on function public\.accept_workspace_invitation/);
  assert.match(sql, /grant execute on function public\.accept_workspace_invitation[\s\S]*to service_role/);
});

test("service RPC correction qualifies overlapping PL/pgSQL output-column names", async () => {
  const sql = await readFile(qualificationMigration, "utf8");
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;\s*$/);
  assert.match(sql, /membership\.workspace_id = p_workspace_id and membership\.user_id = p_actor_user_id/g);
  assert.match(sql, /workspace\.id = p_workspace_id/);
  assert.match(sql, /invitation\.token_hash = p_token_hash/);
  assert.match(sql, /invitation\.id = v_invite\.id and invitation\.status = 'pending'/);
  assert.match(sql, /connection\.workspace_id = p_workspace_id and connection\.user_id = p_target_user_id/);
  assert.doesNotMatch(sql, /security definer/i);
});

test("invite creation keeps Auth identity lookup in supported server API boundary", async () => {
  const sql = await readFile(authBoundaryMigration, "utf8");
  const executableSql = sql.replaceAll(/--.*$/gm, "");
  const service = await readFile("lib/company.ts", "utf8");
  assert.doesNotMatch(executableSql, /auth\.users/);
  assert.match(sql, /current_user <> 'service_role'/);
  assert.match(sql, /revoke all on function public\.create_workspace_invitation/);
  assert.match(service, /admin\.auth\.admin\.getUserById/);
  assert.match(service, /memberEmails\.includes\(normalizedEmail\)/);
});

test("invitation acceptance resolves INSERT columns without trusting caller input", async () => {
  const sql = await readFile(acceptQualificationMigration, "utf8");
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;\s*$/);
  assert.match(sql, /#variable_conflict use_column/);
  assert.match(sql, /insert into public\.workspace_memberships\(workspace_id, user_id, role, is_default\)/);
  assert.match(sql, /v_invite\.normalized_email <> v_email/);
  assert.match(sql, /current_user <> 'service_role'/);
  assert.match(sql, /revoke all on function public\.accept_workspace_invitation/);
  assert.doesNotMatch(sql, /security definer/i);
});

test("removed active memberships recover to an existing trusted workspace", async () => {
  const sql = await readFile(defaultQualificationMigration, "utf8");
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;\s*$/);
  assert.match(sql, /#variable_conflict use_column/);
  assert.match(sql, /elsif v_membership_count > 0 then/);
  assert.match(sql, /order by membership\.created_at, membership\.workspace_id/);
  assert.match(sql, /where membership\.workspace_id = v_workspace_id and membership\.user_id = p_user_id/);
  assert.match(sql, /current_user <> 'service_role'|security invoker/);
  assert.match(sql, /revoke all on function public\.ensure_default_workspace/);
  assert.doesNotMatch(sql, /security definer/i);
});

test("invitation actor foreign keys have covering indexes", async () => {
  const sql = await readFile(invitationIndexesMigration, "utf8");
  assert.match(sql, /^begin;/);
  assert.match(sql, /commit;\s*$/);
  assert.match(sql, /workspace_invitations_created_by_idx[\s\S]*\(created_by\)/);
  assert.match(sql, /workspace_invitations_accepted_by_idx[\s\S]*\(accepted_by\)/);
  assert.match(sql, /workspace_invitations_revoked_by_idx[\s\S]*\(revoked_by\)/);
});

test("expired/revoked/reissued invitations cannot create stale privilege", async () => {
  const sql = await readFile(migration, "utf8");
  const service = await readFile("lib/company.ts", "utf8");
  assert.match(sql, /status in \('pending', 'accepted', 'revoked', 'expired'\)/);
  assert.match(sql, /set status = 'expired'[\s\S]*expires_at <= clock_timestamp\(\)/);
  assert.match(sql, /set status = 'revoked'[\s\S]*normalized_email = v_email and status = 'pending'/);
  assert.match(sql, /if v_invite\.status <> 'pending' then raise exception 'invitation unavailable'/);
  assert.match(sql, /return query select null::uuid, null::text, 'expired'::text/);
  assert.match(service, /\.update\(\{ status: "expired", updated_at:/);
  assert.match(service, /\.eq\("token_hash", hash\)\.eq\("status", "pending"\)\.lte\("expires_at"/);
});

test("server/UI boundary never exposes token hashes or trusts browser role claims", async () => {
  const service = await readFile("lib/company.ts", "utf8");
  const actions = await readFile("app/actions/company.ts", "utf8");
  const ui = await readFile("components/company-admin.tsx", "utf8");
  const invitePage = await readFile("app/invite/accept/page.tsx", "utf8");
  assert.match(service, /import "server-only"/);
  assert.match(service, /getAuthenticatedContext/);
  assert.match(service, /hashInvitationToken/);
  assert.doesNotMatch(ui, /token_hash|tokenHash/);
  assert.doesNotMatch(ui, /router\.refresh/);
  assert.doesNotMatch(invitePage, /token_hash|tokenHash/);
  assert.doesNotMatch(actions, /workspaceId.*get\(/);
  assert.doesNotMatch(service, /user_metadata.*role|role.*user_metadata/);
  assert.match(service, /switch_active_workspace/);
  assert.match(actions, /revalidatePath\("\/", "layout"\)/);
});
