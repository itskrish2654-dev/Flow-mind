import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = "supabase/migrations/20260823000100_d34b1_active_draft_publication.sql";

test("D3.4-B.1 active edit keeps a distinct immutable published version", async () => {
  const [migration, versioning] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile("lib/workflow-versioning.ts", "utf8"),
  ]);
  assert.match(migration, /add column if not exists published_version_id uuid/i);
  assert.match(migration, /set published_version_id = current_version_id[\s\S]*where public_form_enabled is true/i);
  assert.match(migration, /foreign key \(id, published_version_id\)[\s\S]*workflow_versions\(workflow_id, id\)/i);
  assert.match(versioning, /hasUnpublishedChanges:[\s\S]*published_version_id !== identity\.current_version_id/);
  const createVersion = versioning.slice(versioning.indexOf("export async function createImmutableWorkflowVersion"));
  assert.doesNotMatch(createVersion, /published_version_id|public_form_enabled|pinFutureScheduleToVersion/);
});

test("D3.4-B.1 production triggers resolve Version A while draft/test resolves Version B", async () => {
  const [migration, publicRuntime, testAction, versioning] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile("lib/public-workflow.ts", "utf8"),
    readFile("app/actions/execute.ts", "utf8"),
    readFile("lib/workflow-versioning.ts", "utf8"),
  ]);
  assert.match(migration, /join public\.workflow_versions as version on version\.id = workflow\.published_version_id/i);
  assert.match(publicRuntime, /select\("user_id, published_version_id, lifecycle_state"\)/);
  assert.match(publicRuntime, /\.eq\("id", data\.published_version_id\)/);
  assert.match(versioning, /\.eq\("id", identity\.current_version_id\)/);
  assert.match(testAction, /loadWorkflowSnapshot/);
  assert.doesNotMatch(testAction, /published_version_id/);
});

test("D3.4-B.1 publish is one conflict-safe switch and failed publish leaves Version A active", async () => {
  const [migration, action] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile("app/actions/workflow.ts", "utf8"),
  ]);
  assert.match(migration, /^begin;/i);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('workflow-publication:/i);
  assert.match(migration, /for update;/i);
  assert.match(migration, /v_current_version_id <> p_expected_current_version_id[\s\S]*workflow version conflict/i);
  assert.match(migration, /set published_version_id = v_current_version_id,[\s\S]*public_form_enabled = true/i);
  assert.match(migration, /connector_subscriptions[\s\S]*workflow_schedules[\s\S]*set published_version_id = v_current_version_id/i);
  assert.match(migration, /revoke all on function public\.publish_workflow_version[\s\S]*public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.publish_workflow_version[\s\S]*service_role/i);
  assert.match(migration, /commit;\s*$/i);
  const publication = action.slice(action.indexOf("export async function setWorkflowPublication"), action.indexOf("export async function getWorkflowConnectorEndpoints"));
  assert.match(publication, /admin\.rpc\("publish_workflow_version"/);
  assert.doesNotMatch(publication, /\.from\("workflows"\)[\s\S]{0,100}\.update/);
  assert.doesNotMatch(publication, /public_form_enabled: false/);
});

test("D3.4-B.1 draft edits and abandonment never implicitly pause production", async () => {
  const [workspace, journey] = await Promise.all([
    readFile("components/automation-workspace.tsx", "utf8"),
    readFile("components/workflow-journey-panel.tsx", "utf8"),
  ]);
  assert.doesNotMatch(workspace, /pauseForChanges|will turn it off first/);
  assert.match(workspace, /You’re editing changes\. Your current workflow is still running\./);
  assert.match(workspace, /setHasUnpublishedChanges\(true\)/);
  assert.match(journey, /Publish changes/);
  assert.match(journey, /onPublicationChange\(false\)/);
  assert.match(journey, /Turn off workflow/);
});

test("D3.4-B.1 active schedules and connectors move only during publication", async () => {
  const [versioning, schedules, subscriptions, action] = await Promise.all([
    readFile("lib/workflow-versioning.ts", "utf8"),
    readFile("lib/workflow-schedules.ts", "utf8"),
    readFile("lib/connectors/subscriptions.ts", "utf8"),
    readFile("app/actions/workflow.ts", "utf8"),
  ]);
  assert.doesNotMatch(versioning, /pinFutureScheduleToVersion/);
  assert.match(schedules, /export function prepareWorkflowSchedule/);
  assert.match(subscriptions, /export async function prepareWorkflowConnectorPublication/);
  const preparation = subscriptions.slice(
    subscriptions.indexOf("export async function prepareWorkflowConnectorPublication"),
    subscriptions.indexOf("export async function stopUnusedGmailWatches"),
  );
  assert.doesNotMatch(preparation, /\.from\("connector_subscriptions"\)\.update|\.from\("connector_subscriptions"\)\.insert/);
  assert.match(action, /prepareWorkflowConnectorPublication[\s\S]*prepareWorkflowSchedule[\s\S]*publish_workflow_version/);
});

test("D3.4-B.1 prior versions and Change History restoration stay immutable", async () => {
  const [migration, versionsAction] = await Promise.all([
    readFile("supabase/migrations/20260812000100_phase3_execution_reliability.sql", "utf8"),
    readFile("app/actions/versions.ts", "utf8"),
  ]);
  assert.match(migration, /revoke all on table public\.workflow_versions from public, anon, authenticated/i);
  assert.match(versionsAction, /createImmutableWorkflowVersion/);
  assert.match(versionsAction, /scope: "rollback"/);
  assert.doesNotMatch(versionsAction, /\.from\("workflow_versions"\)\.update/);
});
