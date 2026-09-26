import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseTrustedWorkspaceMembership } from "../lib/workspace-context-core";

const MIGRATION = "supabase/migrations/20260926103406_work_os_workspace_foundation.sql";

async function source(path: string) {
  return readFile(path, "utf8");
}

test("workspace foundation creates constrained tenant roots and preserves business-object counts", async () => {
  const migration = await source(MIGRATION);

  assert.match(migration, /^begin;/);
  assert.match(migration, /commit;\s*$/);
  assert.match(migration, /create table public\.workspaces/);
  assert.match(migration, /create table public\.workspace_memberships/);
  assert.match(migration, /primary key \(workspace_id, user_id\)/);
  assert.match(migration, /role in \('owner', 'admin', 'member'\)/);
  assert.match(migration, /create unique index workspace_memberships_one_default_per_user[\s\S]*where is_default/);
  assert.match(migration, /alter table public\.workflows add column workspace_id uuid/);
  assert.match(migration, /alter table public\.connector_connections add column workspace_id uuid/);
  assert.match(migration, /alter column workspace_id set not null/g);
  assert.match(migration, /foreign key \(workspace_id, user_id\)[\s\S]*references public\.workspace_memberships\(workspace_id, user_id\)/);

  for (const table of [
    "workflows",
    "connector_connections",
    "workflow_executions",
    "workflow_schedules",
    "connector_subscriptions",
  ]) {
    assert.match(migration, new RegExp(`expected\\.${table} <> \\(select count\\(\\*\\) from public\\.${table}\\)`));
  }
});

test("default workspace backfill and lazy bootstrap are locked, deterministic, and idempotent", async () => {
  const migration = await source(MIGRATION);
  const bootstrap = migration.slice(
    migration.indexOf("create function public.ensure_default_workspace"),
    migration.indexOf("-- Backfill every Auth account"),
  );

  assert.match(bootstrap, /security invoker/);
  assert.doesNotMatch(bootstrap, /security definer/);
  assert.doesNotMatch(bootstrap, /from auth\.users/);
  assert.match(bootstrap, /pg_advisory_xact_lock/);
  assert.match(bootstrap, /count\(\*\) filter \(where membership\.is_default\)/);
  assert.match(bootstrap, /where membership\.user_id = p_user_id/);
  assert.match(bootstrap, /if v_default_count > 1 then[\s\S]*ambiguous default workspace/);
  assert.match(bootstrap, /if v_default_count = 0 and v_membership_count > 0 then[\s\S]*default workspace is missing/);
  assert.match(bootstrap, /if v_default_count = 0 then[\s\S]*insert into public\.workspaces[\s\S]*insert into public\.workspace_memberships/);
  assert.match(migration, /for account in select id from auth\.users order by id[\s\S]*ensure_default_workspace\(account\.id\)/);
  assert.match(migration, /update public\.workflows[\s\S]*membership\.user_id = workflow\.user_id[\s\S]*membership\.is_default/);
  assert.match(migration, /update public\.connector_connections[\s\S]*membership\.user_id = connection\.user_id[\s\S]*membership\.is_default/);
  assert.match(migration, /every account must have exactly one default workspace/);
  assert.match(migration, /migrated default workspace membership must be owner/);
});

test("trusted membership parser fails closed for missing, ambiguous, or invalid membership", () => {
  const userId = "00000000-0000-4000-8000-000000000001";
  const row = {
    workspace_id: "00000000-0000-4000-8000-000000000010",
    membership_role: "owner" as const,
  };

  assert.deepEqual(parseTrustedWorkspaceMembership(userId, [row]), {
    workspaceId: row.workspace_id,
    userId,
    role: "owner",
    isDefault: true,
  });
  assert.throws(() => parseTrustedWorkspaceMembership(userId, null));
  assert.throws(() => parseTrustedWorkspaceMembership(userId, []));
  assert.throws(() => parseTrustedWorkspaceMembership(userId, [row, row]));
  assert.throws(() => parseTrustedWorkspaceMembership(userId, [{ ...row, workspace_id: "" }]));
});

test("workspace tables deny anonymous enumeration and browser-controlled membership mutation", async () => {
  const migration = await source(MIGRATION);

  assert.match(migration, /alter table public\.workspaces force row level security/);
  assert.match(migration, /alter table public\.workspace_memberships force row level security/);
  assert.match(migration, /revoke all on table public\.workspaces, public\.workspace_memberships[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant select on table public\.workspaces, public\.workspace_memberships[\s\S]*to authenticated/);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete|all)[^;]*public\.workspace_memberships[^;]*to authenticated/);
  assert.match(migration, /create policy workspaces_member_select[\s\S]*membership\.user_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /create policy workspace_memberships_self_select[\s\S]*user_id = \(select auth\.uid\(\)\)/);
  assert.doesNotMatch(migration, /create policy workspace_memberships_(?:insert|update|delete)/);
});

test("workflow and connector roots reject tenant tampering at RLS, FK, trigger, and grant boundaries", async () => {
  const migration = await source(MIGRATION);
  const ownershipTrigger = migration.slice(
    migration.indexOf("create function public.enforce_default_workspace_ownership"),
    migration.indexOf("-- Preserve user ownership"),
  );

  assert.match(ownershipTrigger, /security invoker/);
  assert.doesNotMatch(ownershipTrigger, /security definer/);
  assert.match(ownershipTrigger, /if v_default_count <> 1/);
  assert.match(ownershipTrigger, /new\.workspace_id is not null and new\.workspace_id <> v_workspace_id/);
  assert.match(ownershipTrigger, /workspace ownership mismatch/);
  assert.match(ownershipTrigger, /new\.workspace_id := v_workspace_id/);
  assert.match(migration, /before insert or update of user_id, workspace_id[\s\S]*on public\.workflows/);
  assert.match(migration, /before insert or update of user_id, workspace_id[\s\S]*on public\.connector_connections/);
  assert.match(migration, /revoke insert, update, delete on table public\.workflows from authenticated/);
  assert.match(migration, /revoke all on table public\.connector_connections from anon, authenticated/);
  assert.match(migration, /grant select on table public\.connector_connections to authenticated/);
  assert.match(migration, /user_id = \(select auth\.uid\(\)\)[\s\S]*membership\.workspace_id = workflows\.workspace_id/);
  assert.match(migration, /membership\.workspace_id = connector_connections\.workspace_id[\s\S]*membership\.user_id = \(select auth\.uid\(\)\)/);
});

test("server authentication resolves one trusted workspace without a client workspace parameter", async () => {
  const auth = await source("lib/auth.ts");
  const resolver = await source("lib/workspace-context.ts");
  const resolverCore = await source("lib/workspace-context-core.ts");
  const workflow = await source("app/actions/workflow.ts");

  assert.match(auth, /resolveTrustedWorkspaceMembership\(user\.id\)/);
  assert.match(auth, /workspace: \{ id: membership\.workspaceId \}/);
  assert.match(resolver, /createAdminClient\(\)\.rpc\([\s\S]*"ensure_default_workspace"/);
  assert.match(resolverCore, /rows\.length !== 1/);
  assert.match(workflow, /export async function compileWorkflow\(\s*prompt: string,\s*existingWorkflowId: string \| null = null,\s*editIntent\?/);
  assert.doesNotMatch(workflow, /export async function compileWorkflow\([^)]*workspaceId/);
  assert.match(workflow, /create_versioned_workflow_with_quota/);
  assert.match(workflow, /\.eq\("workspace_id", auth\.workspace\.id\)/);
});

test("connector creation and OAuth finalization bind to server-trusted workspace context", async () => {
  const callback = await source("app/api/connectors/oauth/[connectorId]/callback/route.ts");
  const start = await source("app/api/connectors/oauth/[connectorId]/start/route.ts");
  const googleFinalization = await source("lib/connectors/google/connection-finalization.ts");
  const airtable = await source("lib/connectors/airtable/customer-connection.ts");
  const gmailAcceptance = await source("lib/operations/gmail-live-acceptance-oauth.ts");

  assert.match(callback, /getAuthenticatedContext/);
  assert.match(callback, /workspace_id: auth\.workspace\.id/);
  assert.match(callback, /\.eq\("workspace_id", auth\.workspace\.id\)/);
  assert.match(start, /\.eq\("workspace_id", auth\.workspace\.id\)/);
  assert.match(googleFinalization, /resolveTrustedWorkspaceMembership\(input\.userId\)/);
  assert.match(googleFinalization, /\.eq\("workspace_id", membership\.workspaceId\)/);
  assert.match(airtable, /getAuthenticatedContext/);
  assert.doesNotMatch(airtable, /workspaceId\s*:/);
  assert.match(gmailAcceptance, /GMAIL_LIVE_ACCEPTANCE_MARKER/);
  assert.match(gmailAcceptance, /resolveTrustedWorkspaceMembership\(input\.userId\)/);
});

test("account export and deletion preserve private-workspace isolation without exposing secrets", async () => {
  const exportRoute = await source("app/settings/export/route.ts");
  const accountAction = await source("app/actions/account.ts");
  const migration = await source(MIGRATION);

  assert.match(exportRoute, /workspace_id", auth\.workspace\.id/);
  assert.match(exportRoute, /role: auth\.membership\.role/);
  assert.doesNotMatch(exportRoute, /ciphertext|auth_tag|SUPABASE_SECRET_KEY/);
  assert.match(accountAction, /getAuthenticatedContext/);
  assert.match(accountAction, /cleanup_connector_account_data/);
  assert.match(accountAction, /cleanup_account_data/);
  assert.match(migration, /delete from public\.workspace_memberships where user_id = p_user_id/);
  assert.match(migration, /delete from public\.workspaces as workspace[\s\S]*not exists \([\s\S]*workspace_memberships[\s\S]*not exists \([\s\S]*workflows[\s\S]*not exists \([\s\S]*connector_connections/);
});

test("workspace-aware user paths cover My Day, workflow IDs, connector IDs, and connection views", async () => {
  const paths = [
    "lib/my-day.ts",
    "lib/workflow-versioning.ts",
    "lib/connectors/connection-view.ts",
    "lib/connectors/connection-vault.ts",
    "app/actions/executions.ts",
    "app/actions/credentials.ts",
    "app/actions/customize.ts",
    "app/connections/page.tsx",
  ];
  for (const path of paths) {
    const contents = await source(path);
    assert.match(contents, /workspace_id/);
  }
});
