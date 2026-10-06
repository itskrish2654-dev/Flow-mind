import { randomBytes } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { decryptCredential } from "../lib/security/credential-crypto";
import type { Database } from "../lib/supabase/types";

test.use({ trace: "off", video: "off", screenshot: "off" });

const ACCEPTANCE_REF = "gamdxwtgccluifatcrrs";
const STAGING_ORIGIN = "https://staging.crazy-loops.com";
const CHANNEL_NAME = "test-crazyloops";
const CHANNEL_ID = "C0BR8V8MKDW";
const MARKER = process.env.WORK_OS_SLACK_MESSAGE_MARKER
  ?? "CrazyLoops Slack v1 acceptance: reviewed test message 846f215e443a.";

function requireStagingOrigin(baseURL: string | undefined) {
  if (!baseURL || new URL(baseURL).origin !== STAGING_ORIGIN) {
    throw new Error("Live Slack acceptance requires the isolated staging origin.");
  }
}

async function ask(page: Page, question: string) {
  await page.goto("/ask");
  await page.getByLabel("Ask CrazyLoops").fill(question);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("region", { name: "Ask conversation" }).getByText(question, { exact: true }))
    .toBeVisible({ timeout: 30_000 });
  const preview = page.getByRole("region", { name: "Action preview" });
  await expect(preview).toBeVisible({ timeout: 45_000 });
  return preview;
}

async function countProviderMessages(input: {
  admin: SupabaseClient<Database>;
  userId: string;
  connectionId: string;
  marker: string;
  threadTs?: string;
}) {
  const { data: vault, error } = await input.admin.from("connector_connection_credentials")
    .select("ciphertext,nonce,auth_tag,algorithm,encryption_version")
    .eq("connection_id", input.connectionId).eq("user_id", input.userId)
    .eq("credential_key", "access_token").single();
  if (error || !vault) throw new Error("The disposable Slack credential is unavailable.");
  const token = decryptCredential({
    ciphertext: vault.ciphertext,
    nonce: vault.nonce,
    authTag: vault.auth_tag,
    algorithm: vault.algorithm as "aes-256-gcm",
    encryptionVersion: vault.encryption_version as 1,
  }, { userId: input.userId, workflowId: `connection:${input.connectionId}`, connectorId: "slack", credentialKey: "access_token" });
  const query = new URLSearchParams({ channel: CHANNEL_ID, limit: "200", ...(input.threadTs ? { ts: input.threadTs } : {}) });
  const method = input.threadTs ? "conversations.replies" : "conversations.history";
  const response = await fetch(`https://slack.com/api/${method}?${query}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json() as { ok?: boolean; has_more?: boolean; messages?: Array<{ text?: string; ts?: string; thread_ts?: string }> };
  if (!response.ok || !result.ok || result.has_more || !Array.isArray(result.messages)) {
    throw new Error("Slack provider history could not establish a complete acceptance baseline.");
  }
  if (input.threadTs && result.messages[0]?.ts !== input.threadTs) {
    throw new Error("The exact Slack parent message is not available in provider history.");
  }
  return result.messages.filter((message) => message.text?.includes(input.marker)).length;
}

test("one real approved Slack post is acknowledged and persisted", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  if (process.env.WORK_OS_SLACK_LIVE_ACCEPTANCE_ENABLED !== "true") test.skip();
  requireStagingOrigin(baseURL);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secret = process.env.SUPABASE_SECRET_KEY;
  const userId = process.env.WORK_OS_SLACK_ACCEPTANCE_USER_ID;
  if (!url || !publishable || !secret || !userId || new URL(url).hostname.split(".")[0] !== ACCEPTANCE_REF) {
    throw new Error("Acceptance project or fixture configuration is missing.");
  }
  const admin = createClient<Database>(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userResult, error: userError } = await admin.auth.admin.getUserById(userId);
  const user = userResult.user;
  if (userError || !user?.email || user.user_metadata?.acceptance_run !== "work-os-slack-v1") {
    throw new Error("The marked disposable Slack acceptance user is unavailable.");
  }
  const { data: connections, error: connectionError } = await admin.from("connector_connections")
    .select("id,status,granted_scopes,workspace_id").eq("user_id", userId).eq("provider_family", "slack");
  if (connectionError || connections?.length !== 1 || connections[0].status !== "connected") {
    throw new Error("The disposable Slack installation is not connected.");
  }
  const { data: previousActions, error: actionCountError } = await admin.from("action_executions")
    .select("id").eq("requester_user_id", userId).eq("capability_id", "slack_send_channel_message");
  if (actionCountError || !previousActions) throw new Error("The Slack action baseline is unavailable.");
  const previousActionIds = new Set(previousActions.map((action) => action.id));
  expect(await countProviderMessages({ admin, userId, connectionId: connections[0].id, marker: MARKER })).toBe(0);

  const password = `Ac!${randomBytes(24).toString("base64url")}7z`;
  const changed = await admin.auth.admin.updateUserById(userId, { password });
  if (changed.error) throw new Error("Disposable account password could not be updated.");
  await page.goto("/login?next=/ask", { waitUntil: "networkidle" });
  await page.getByLabel("Email address").fill(user.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in securely" }).click();
  await page.waitForURL((value) => value.pathname === "/ask", { timeout: 30_000 });

  const preview = await ask(page, `Tell #${CHANNEL_NAME} that ${MARKER}`);
  await expect(preview).toContainText(`#${CHANNEL_NAME}`);
  await expect(preview).toContainText(MARKER);
  await expect(preview).toContainText("Nothing has been sent or changed yet.");
  const { count: beforeApprovalCount } = await admin.from("action_executions")
    .select("id", { count: "exact", head: true }).eq("requester_user_id", userId).eq("capability_id", "slack_send_channel_message");
  expect(beforeApprovalCount).toBe(previousActionIds.size);

  await preview.getByRole("button", { name: /Review and request approval/ }).click();
  await page.waitForURL(/\/my-day\?action=pending_approval/, { timeout: 30_000 });
  const { data: actions, error: actionsError } = await admin.from("action_executions").select("*")
    .eq("requester_user_id", userId).eq("capability_id", "slack_send_channel_message");
  const newActions = actions?.filter((action) => !previousActionIds.has(action.id));
  if (actionsError || newActions?.length !== 1 || newActions[0].status !== "pending_approval") {
    throw new Error("Exactly one pending Slack action was not persisted.");
  }
  const action = newActions[0];
  const { data: approval, error: approvalError } = await admin.from("approval_requests")
    .select("action_snapshot").eq("id", action.approval_request_id).single();
  if (approvalError || !approval) throw new Error("Frozen Slack approval snapshot is missing.");
  const snapshot = approval.action_snapshot as {
    target?: { reference?: string };
    parameters?: Array<{ name?: string; value?: string }>;
  };
  expect(snapshot.target?.reference).toMatch(/^C[A-Z0-9]{8,20}$/);
  expect(snapshot.parameters?.find((item) => item.name === "text")?.value).toBe(MARKER);
  expect(action.attempt_count).toBe(0);

  // This is the only real consequential click in the live test. Never retry
  // automatically if the result is ambiguous or the browser loses its reply.
  await page.getByRole("heading", { name: `Post to #${CHANNEL_NAME} in Slack` })
    .locator("..").filter({ hasText: MARKER }).getByRole("button", { name: "Approve" }).click();
  await expect.poll(async () => {
    const result = await admin.from("action_executions").select("status").eq("id", action.id).single();
    if (result.error) throw result.error;
    return ["succeeded", "failed", "ambiguous"].includes(result.data.status);
  }, { timeout: 45_000 }).toBe(true);
  const { data: final, error: finalError } = await admin.from("action_executions").select("*").eq("id", action.id).single();
  if (finalError || !final) throw new Error("Slack execution outcome is missing.");
  expect(final.status).toBe("succeeded");
  expect(final.attempt_count).toBe(1);
  expect(final.acknowledged).toBe(true);
  expect(final.externally_delivered).toBe(true);
  expect(final.provider_reference_id).toMatch(/^C[A-Z0-9]{8,20}:\d{10,20}\.\d{1,10}$/);
  expect(final.provider_reference_id?.startsWith(`${snapshot.target?.reference}:`)).toBe(true);
  await expect.poll(() => countProviderMessages({ admin, userId, connectionId: connections[0].id, marker: MARKER }),
    { timeout: 20_000 }).toBe(1);
  const { data: workItem, error: workItemError } = await admin.from("work_items")
    .select("status").eq("id", final.work_item_id).single();
  if (workItemError) throw workItemError;
  expect(workItem.status).toBe("handled");
  await page.reload();
  await expect(page.getByText(/Approved action completed/).first()).toBeVisible({ timeout: 30_000 });
});

test("one approved Slack thread reply is acknowledged and a stale second decision cannot repeat it", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  if (process.env.WORK_OS_SLACK_LIVE_ACCEPTANCE_ENABLED !== "true") test.skip();
  requireStagingOrigin(baseURL);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  const userId = process.env.WORK_OS_SLACK_ACCEPTANCE_USER_ID;
  const parentTs = process.env.WORK_OS_SLACK_PARENT_TS;
  const replyMarker = process.env.WORK_OS_SLACK_REPLY_MARKER;
  if (!url || !secret || !userId || !parentTs || !/^\d{10,20}\.\d{1,10}$/.test(parentTs)
    || !replyMarker || new URL(url).hostname.split(".")[0] !== ACCEPTANCE_REF) {
    throw new Error("The exact staging reply fixture is unavailable.");
  }
  const admin = createClient<Database>(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: owner, error: ownerError } = await admin.auth.admin.getUserById(userId);
  if (ownerError || !owner.user?.email || owner.user.user_metadata?.acceptance_run !== "work-os-slack-v1") {
    throw new Error("The marked disposable Slack owner is unavailable.");
  }
  const { data: connections, error: connectionError } = await admin.from("connector_connections")
    .select("id,status,granted_scopes").eq("user_id", userId).eq("provider_family", "slack");
  if (connectionError || connections?.length !== 1 || connections[0].status !== "connected"
    || !["channels:read", "channels:history", "chat:write"].every((scope) => connections[0].granted_scopes.includes(scope))) {
    throw new Error("The minimum-scope disposable Slack connection is unavailable.");
  }
  const connectionId = connections[0].id;
  expect(await countProviderMessages({ admin, userId, connectionId, marker: replyMarker, threadTs: parentTs })).toBe(0);
  const { data: previousActions, error: baselineError } = await admin.from("action_executions")
    .select("id").eq("requester_user_id", userId).eq("capability_id", "slack_reply_in_thread");
  if (baselineError || !previousActions) throw new Error("The Slack reply baseline is unavailable.");
  const previousActionIds = new Set(previousActions.map((action) => action.id));

  const password = `Ac!${randomBytes(24).toString("base64url")}7z`;
  if ((await admin.auth.admin.updateUserById(userId, { password })).error) {
    throw new Error("Disposable test login could not be refreshed.");
  }
  await page.goto("/login?next=/ask", { waitUntil: "networkidle" });
  await page.getByLabel("Email address").fill(owner.user.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in securely" }).click();
  await page.waitForURL((value) => value.pathname === "/ask", { timeout: 30_000 });

  const preview = await ask(page, `Reply in #${CHANNEL_NAME} to thread ${parentTs} with ${replyMarker}`);
  await expect(preview).toContainText(parentTs);
  await expect(preview).toContainText(replyMarker);
  await expect(preview).toContainText("Nothing has been sent or changed yet.");
  await preview.getByRole("button", { name: /Review and request approval/ }).click();
  await page.waitForURL(/\/my-day\?action=pending_approval/, { timeout: 30_000 });
  const { data: actions, error: actionsError } = await admin.from("action_executions").select("*")
    .eq("requester_user_id", userId).eq("capability_id", "slack_reply_in_thread");
  const newActions = actions?.filter((action) => !previousActionIds.has(action.id));
  if (actionsError || newActions?.length !== 1 || newActions[0].status !== "pending_approval") {
    throw new Error("Exactly one pending Slack reply was not persisted.");
  }
  const action = newActions[0];
  const { data: approval, error: approvalError } = await admin.from("approval_requests")
    .select("action_snapshot").eq("id", action.approval_request_id).single();
  if (approvalError || !approval) throw new Error("Frozen Slack reply snapshot is missing.");
  const snapshot = approval.action_snapshot as {
    target?: { reference?: string };
    parameters?: Array<{ name?: string; value?: string }>;
  };
  expect(snapshot.target?.reference).toBe(`${CHANNEL_ID}:${parentTs}`);
  expect(snapshot.parameters?.find((item) => item.name === "threadTs")?.value).toBe(parentTs);
  expect(snapshot.parameters?.find((item) => item.name === "text")?.value).toBe(replyMarker);
  expect(action.attempt_count).toBe(0);
  const stalePage = await page.context().newPage();
  await stalePage.goto("/my-day", { waitUntil: "networkidle" });
  const staleCard = stalePage.locator("article").filter({ hasText: replyMarker });
  await expect(staleCard.getByRole("button", { name: "Approve" })).toBeVisible();

  // One consequential approval. A later stale decision is attempted only
  // after provider success is confirmed, so it cannot mask an ambiguous send.
  await page.locator("article").filter({ hasText: replyMarker }).getByRole("button", { name: "Approve" }).click();
  await expect.poll(async () => {
    const result = await admin.from("action_executions").select("status").eq("id", action.id).single();
    if (result.error) throw result.error;
    return ["succeeded", "failed", "ambiguous"].includes(result.data.status);
  }, { timeout: 45_000 }).toBe(true);
  const { data: final, error: finalError } = await admin.from("action_executions").select("*").eq("id", action.id).single();
  if (finalError || !final) throw new Error("Slack reply execution outcome is missing.");
  expect(final.status).toBe("succeeded");
  expect(final.attempt_count).toBe(1);
  expect(final.acknowledged).toBe(true);
  expect(final.externally_delivered).toBe(true);
  expect(final.provider_reference_id).toMatch(new RegExp(`^${CHANNEL_ID}:\\d{10,20}\\.\\d{1,10}$`));
  await expect.poll(() => countProviderMessages({ admin, userId, connectionId, marker: replyMarker, threadTs: parentTs }),
    { timeout: 20_000 }).toBe(1);

  await staleCard.getByRole("button", { name: "Approve" }).click();
  await expect(stalePage.getByText("That approval could not be decided.", { exact: false })).toBeVisible({ timeout: 30_000 });
  const after = await admin.from("action_executions").select("status,attempt_count").eq("id", action.id).single();
  if (after.error) throw after.error;
  expect(after.data.status).toBe("succeeded");
  expect(after.data.attempt_count).toBe(1);
  expect(await countProviderMessages({ admin, userId, connectionId, marker: replyMarker, threadTs: parentTs })).toBe(1);
});

test("persisted Slack outcome remains truthful in My Day and Ask", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  if (process.env.WORK_OS_SLACK_LIVE_ACCEPTANCE_ENABLED !== "true") test.skip();
  requireStagingOrigin(baseURL);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  const userId = process.env.WORK_OS_SLACK_ACCEPTANCE_USER_ID;
  if (!url || !secret || !userId || new URL(url).hostname.split(".")[0] !== ACCEPTANCE_REF) {
    throw new Error("Acceptance project or fixture configuration is missing.");
  }
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: owner, error: ownerError } = await admin.auth.admin.getUserById(userId);
  if (ownerError || !owner.user?.email || owner.user.user_metadata?.acceptance_run !== "work-os-slack-v1") {
    throw new Error("Marked disposable Slack owner is unavailable.");
  }
  const { data: action, error: actionError } = await admin.from("action_executions").select("*")
    .eq("requester_user_id", userId).eq("capability_id", "slack_send_channel_message")
    .order("created_at", { ascending: false }).limit(1).single();
  if (actionError || !action || action.status !== "succeeded" || !action.acknowledged || !action.externally_delivered) {
    throw new Error("The real acknowledged Slack action is missing.");
  }
  const { data: approval, error: approvalError } = await admin.from("approval_requests")
    .select("action_snapshot").eq("id", action.approval_request_id).single();
  if (approvalError || !approval) throw new Error("The approved Slack action snapshot is missing.");
  const snapshot = approval.action_snapshot as { parameters?: Array<{ name?: string; value?: string }> };
  expect(snapshot.parameters?.find((item) => item.name === "text")?.value).toBe(MARKER);
  const { count: initialActionCount } = await admin.from("action_executions").select("id", { count: "exact", head: true })
    .eq("requester_user_id", userId).eq("capability_id", "slack_send_channel_message");
  const password = `Ac!${randomBytes(24).toString("base64url")}7z`;
  if ((await admin.auth.admin.updateUserById(userId, { password })).error) {
    throw new Error("Disposable test login could not be refreshed.");
  }
  await page.goto("/login?next=/my-day", { waitUntil: "networkidle" });
  await page.getByLabel("Email address").fill(owner.user.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in securely" }).click();
  await page.waitForURL((value) => value.pathname === "/my-day", { timeout: 30_000 });
  await expect(page.getByText("Approved action completed").first()).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByText("Approved action completed").first()).toBeVisible({ timeout: 30_000 });

  const question = `Did CrazyLoops send the approved Slack test message "${MARKER}"?`;
  await page.goto("/ask");
  await page.getByLabel("Ask CrazyLoops").fill(question);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("region", { name: "Ask conversation" }).getByText(question, { exact: true }))
    .toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => {
    const turn = await admin.from("ask_turns").select("state").eq("user_id", userId).eq("question", question)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (turn.error) throw turn.error;
    return turn.data?.state ?? null;
  }, { timeout: 60_000 }).toBe("completed");
  const turn = await admin.from("ask_turns").select("id").eq("user_id", userId).eq("question", question)
    .order("created_at", { ascending: false }).limit(1).single();
  if (turn.error) throw turn.error;
  await expect.poll(async () => {
    const result = await admin.from("ask_messages").select("id").eq("turn_id", turn.data.id)
      .eq("role", "assistant").maybeSingle();
    if (result.error) throw result.error;
    return Boolean(result.data);
  }, { timeout: 30_000 }).toBe(true);
  const answer = await admin.from("ask_messages").select("content,response_metadata").eq("turn_id", turn.data.id)
    .eq("role", "assistant").single();
  if (answer.error) throw answer.error;
  expect(answer.data.content).toMatch(/sent|posted|completed|succeeded/i);
  expect(answer.data.content).not.toMatch(/not sent|not posted|could not confirm/i);
  const metadata = answer.data.response_metadata as { references?: Array<{ kind?: string; entityId?: string }> } | null;
  expect(metadata?.references?.some((reference) => reference.kind === "action_execution" && reference.entityId === action.id)).toBe(true);
  const after = await admin.from("action_executions").select("id", { count: "exact", head: true })
    .eq("requester_user_id", userId).eq("capability_id", "slack_send_channel_message");
  expect(after.count).toBe(initialActionCount);
});

test("a real signed Slack message becomes one Work Item and a grounded Ask source", async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  if (process.env.WORK_OS_SLACK_LIVE_ACCEPTANCE_ENABLED !== "true") test.skip();
  requireStagingOrigin(baseURL);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  const userId = process.env.WORK_OS_SLACK_ACCEPTANCE_USER_ID;
  if (!url || !secret || !userId || new URL(url).hostname.split(".")[0] !== ACCEPTANCE_REF) {
    throw new Error("Acceptance project or fixture configuration is missing.");
  }
  const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: owner, error: ownerError } = await admin.auth.admin.getUserById(userId);
  if (ownerError || !owner.user?.email || owner.user.user_metadata?.acceptance_run !== "work-os-slack-v1") {
    throw new Error("Marked disposable Slack owner is unavailable.");
  }
  const inboundMarker = process.env.WORK_OS_SLACK_INBOUND_MARKER;
  if (!inboundMarker || !/^SLACK-LIVE-INBOUND-[A-Za-z0-9-]{8,80}$/.test(inboundMarker)) {
    throw new Error("A fresh, bounded Slack inbound acceptance marker is required.");
  }
  const { data: matchingEvents, error: eventError } = await admin.from("slack_message_events")
    .select("id,connection_id,channel_id,message_text,provider_event_id")
    .eq("user_id", userId).like("message_text", `%${inboundMarker}%`);
  if (eventError || matchingEvents?.length !== 1 || matchingEvents[0].channel_id !== "C0BR8V8MKDW"
    || !matchingEvents[0].message_text.includes("please review")) {
    throw new Error("Exactly one real, actionable test-channel Slack event was not captured.");
  }
  const inbound = matchingEvents[0];
  const { data: matchingWork, error: workError } = await admin.from("work_items")
    .select("id,status,source_type,source_id,source_label,dedupe_key,summary")
    .eq("assignee_user_id", userId).eq("source_type", "connector_event")
    .eq("source_id", inbound.connection_id).like("summary", `%${inboundMarker}%`);
  if (workError || matchingWork?.length !== 1 || matchingWork[0].status !== "needs_you"
    || matchingWork[0].source_label !== "Slack" || !matchingWork[0].dedupe_key?.startsWith("slack-event:")) {
    throw new Error("The signed actionable message did not create exactly one sourced Work Item.");
  }

  const password = `Ac!${randomBytes(24).toString("base64url")}7z`;
  if ((await admin.auth.admin.updateUserById(userId, { password })).error) {
    throw new Error("Disposable test login could not be refreshed.");
  }
  await page.goto("/login?next=/my-day", { waitUntil: "networkidle" });
  await page.getByLabel("Email address").fill(owner.user.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Log in securely" }).click();
  await page.waitForURL((value) => value.pathname === "/my-day", { timeout: 30_000 });
  await expect(page.locator(`#work-item-${matchingWork[0].id}`)).toContainText(inboundMarker);

  const question = `What did the Slack message in #${CHANNEL_NAME} ask me to review? Its marker was ${inboundMarker}.`;
  await page.goto("/ask");
  await page.getByLabel("Ask CrazyLoops").fill(question);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("region", { name: "Ask conversation" }).getByText(question, { exact: true }))
    .toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => {
    const turn = await admin.from("ask_turns").select("state").eq("user_id", userId).eq("question", question)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (turn.error) throw turn.error;
    return turn.data?.state ?? null;
  }, { timeout: 60_000 }).toBe("completed");
  const turn = await admin.from("ask_turns").select("id").eq("user_id", userId).eq("question", question)
    .order("created_at", { ascending: false }).limit(1).single();
  if (turn.error) throw turn.error;
  const answer = await admin.from("ask_messages").select("content,response_metadata")
    .eq("turn_id", turn.data.id).eq("role", "assistant").single();
  if (answer.error) throw answer.error;
  expect(answer.data.content).toMatch(/review/i);
  const metadata = answer.data.response_metadata as { references?: Array<{ kind?: string; entityId?: string; href?: string }> } | null;
  const sourceHref = `/dashboard/slack/${inbound.connection_id}/${inbound.id}`;
  expect(metadata?.references?.some((reference) => reference.kind === "slack_message"
    && reference.entityId === inbound.id && reference.href === sourceHref)).toBe(true);
  await page.reload();
  const source = page.locator(`a[href="${sourceHref}"]`);
  await expect(source).toBeVisible({ timeout: 30_000 });
  await source.click();
  await page.waitForURL((value) => value.pathname === sourceHref, { timeout: 30_000 });
  await expect(page.getByRole("region", { name: "Slack message text" })).toContainText(inboundMarker);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
