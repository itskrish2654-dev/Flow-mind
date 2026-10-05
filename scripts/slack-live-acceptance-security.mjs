import { randomBytes, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

const expectedProject = "gamdxwtgccluifatcrrs";
const ownerId = process.env.WORK_OS_SLACK_ACCEPTANCE_USER_ID;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!ownerId || !url || !publishable || !secret || new URL(url).hostname.split(".")[0] !== expectedProject) {
  throw new Error("The marked acceptance owner/project is required.");
}

const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
let outsider = null;
let outsiderWorkspaceId = null;
let memberAdded = false;

try {
  const owner = await admin.auth.admin.getUserById(ownerId);
  if (owner.error || !owner.data.user?.email || owner.data.user.user_metadata?.acceptance_run !== "work-os-slack-v1") {
    throw new Error("The marked acceptance owner is missing.");
  }
  const connection = await admin.from("connector_connections").select("id,workspace_id")
    .eq("user_id", ownerId).eq("provider_family", "slack").single();
  const action = await admin.from("action_executions").select("id,approval_request_id,work_item_id")
    .eq("requester_user_id", ownerId).eq("capability_id", "slack_send_channel_message").single();
  if (connection.error || action.error || !connection.data || !action.data) throw new Error("Accepted Slack fixtures are missing.");

  const ownerPassword = `Ac!${randomBytes(24).toString("base64url")}7z`;
  if ((await admin.auth.admin.updateUserById(ownerId, { password: ownerPassword })).error) {
    throw new Error("Owner test password could not be refreshed.");
  }
  const outsiderEmail = `slack-outsider-${randomUUID().replaceAll("-", "").slice(0, 12)}@example.com`;
  const outsiderPassword = `Ac!${randomBytes(24).toString("base64url")}7z`;
  const created = await admin.auth.admin.createUser({
    email: outsiderEmail,
    password: outsiderPassword,
    email_confirm: true,
    user_metadata: { acceptance_run: "work-os-slack-v1-security" },
  });
  if (created.error || !created.data.user) throw new Error("Outsider fixture could not be created.");
  outsider = created.data.user.id;
  const workspace = await admin.rpc("ensure_default_workspace", { p_user_id: outsider });
  if (workspace.error || !workspace.data?.[0]?.workspace_id) throw new Error("Outsider workspace could not be created.");
  outsiderWorkspaceId = workspace.data[0].workspace_id;

  async function session(email, password) {
    const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data.session) throw new Error("Issued browser-role session failed.");
    return client;
  }
  const a = await session(owner.data.user.email, ownerPassword);
  const b = await session(outsiderEmail, outsiderPassword);
  const ownerPositive = await a.from("connector_connections").select("id").eq("id", connection.data.id);
  const outsiderConnection = await b.from("connector_connections").select("id").eq("id", connection.data.id);
  const outsiderAction = await b.from("action_executions").select("id").eq("id", action.data.id);
  const outsiderApproval = await b.from("approval_requests").select("id").eq("id", action.data.approval_request_id);
  const outsiderWork = await b.from("work_items").select("id").eq("id", action.data.work_item_id);
  const outsiderVault = await b.from("connector_connection_credentials").select("id")
    .eq("connection_id", connection.data.id);

  const membership = await admin.from("workspace_memberships").insert({
    workspace_id: connection.data.workspace_id,
    user_id: outsider,
    role: "member",
    is_default: false,
  });
  if (membership.error) throw new Error("Same-workspace member fixture could not be created.");
  memberAdded = true;
  const sameWorkspaceConnection = await b.from("connector_connections").select("id").eq("id", connection.data.id);
  const sameWorkspaceAction = await b.from("action_executions").select("id").eq("id", action.data.id);
  const claim = await b.rpc("claim_action_execution", { p_execution_id: action.data.id, p_actor_user_id: outsider });
  const decision = await b.rpc("decide_action_execution", {
    p_approval_id: action.data.approval_request_id,
    p_actor_user_id: outsider,
    p_decision: "approved",
    p_rejection_reason: null,
  });
  const result = {
    ownerCanSeeOwnConnection: ownerPositive.data?.length === 1,
    outsiderCannotSeeConnection: outsiderConnection.data?.length === 0,
    outsiderCannotSeeAction: outsiderAction.data?.length === 0,
    outsiderCannotSeeApproval: outsiderApproval.data?.length === 0,
    outsiderCannotSeeWorkItem: outsiderWork.data?.length === 0,
    outsiderCannotReadVault: !!outsiderVault.error && !outsiderVault.data?.length,
    sameWorkspaceMemberCannotSeeConnection: sameWorkspaceConnection.data?.length === 0,
    sameWorkspaceMemberCannotSeeAction: sameWorkspaceAction.data?.length === 0,
    browserCannotClaimAction: !!claim.error,
    browserCannotDecideApproval: !!decision.error,
  };
  console.log(JSON.stringify(result));
  if (Object.values(result).some((value) => value !== true)) process.exitCode = 1;
} finally {
  if (outsider && memberAdded) {
    const removed = await admin.from("workspace_memberships").delete().eq("user_id", outsider)
      .eq("workspace_id", (await admin.from("connector_connections").select("workspace_id")
        .eq("user_id", ownerId).eq("provider_family", "slack").single()).data?.workspace_id);
    if (removed.error) throw new Error("Same-workspace fixture cleanup failed.");
  }
  if (outsiderWorkspaceId) {
    const removed = await admin.from("workspaces").delete().eq("id", outsiderWorkspaceId).eq("created_by", outsider);
    if (removed.error) throw new Error("Outsider workspace cleanup failed.");
  }
  if (outsider) {
    const removed = await admin.auth.admin.deleteUser(outsider);
    if (removed.error) throw new Error("Outsider user cleanup failed.");
  }
  console.log("outsider_fixture_cleanup=PASS");
}
