import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

const ACCEPTANCE_REF = "gamdxwtgccluifatcrrs";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing acceptance configuration: ${name}`);
  return value;
}

async function waitForAskPreview(page: Page) {
  const preview = page.getByRole("region", { name: "Action preview" });
  for (let index = 0; index < 50; index += 1) {
    if (await preview.isVisible().catch(() => false)) return preview;
    const check = page.getByRole("button", { name: "Check status" });
    if (await check.isVisible().catch(() => false)) await check.click();
    await page.waitForTimeout(500);
  }
  throw new Error("Ask did not produce a terminal exact Gmail preview.");
}

function dispatchAcceptanceFixture() {
  const script = [
    'const M=require("module"),old=M._load;',
    'M._load=function(name,...args){if(name==="server-only")return {};return old.call(this,name,...args)};',
    'require("tsx/cjs");',
    'const {dispatchDueWorkItemAutomations}=require("./lib/automate-this-dispatch.ts");',
    'dispatchDueWorkItemAutomations(1,new Date())',
    '.then(m=>{console.log(JSON.stringify(m))})',
    '.catch(()=>{console.error("DISPATCH_FAILED");process.exit(1)})',
  ].join("");
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 150_000,
  });
  if (result.error || result.status !== 0) throw new Error("Bounded local-clock acceptance dispatch failed.");
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!line) throw new Error("Acceptance dispatch returned no metrics.");
  return JSON.parse(line) as { inspected: number; claimed: number; prepared: number; failed: number };
}

test("reviewed Gmail follow-up automation requires exact approval and sends once", async ({ browser, baseURL }) => {
  test.setTimeout(900_000);
  if (process.env.AUTOMATE_THIS_GMAIL_LIVE_ENABLED !== "true"
    || baseURL !== "https://staging.crazy-loops.com") throw new Error("Live Gmail acceptance is not explicitly enabled.");
  const url = required("NEXT_PUBLIC_SUPABASE_URL");
  if (new URL(url).hostname !== `${ACCEPTANCE_REF}.supabase.co`) throw new Error("Wrong database target.");
  const admin = createClient(url, required("SUPABASE_SECRET_KEY"), { auth: { persistSession: false } });
  const publicClient = createClient(url, required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const connectionRows = await admin.from("connector_connections")
    .select("id,user_id,workspace_id,external_account_label,granted_scopes")
    .eq("provider_family", "google").eq("status", "connected");
  if (connectionRows.error) throw new Error("Acceptance Gmail connection metadata is unavailable.");
  const gmail = connectionRows.data.filter((row) => row.granted_scopes.includes(GMAIL_SEND_SCOPE));
  if (gmail.length !== 1 || !gmail[0].external_account_label
    || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(gmail[0].external_account_label)) {
    throw new Error("Exactly one self-addressed acceptance Gmail connection is required.");
  }
  const ownerId = gmail[0].user_id;
  const workspaceId = gmail[0].workspace_id;
  const recipient = gmail[0].external_account_label;
  const account = await admin.auth.admin.getUserById(ownerId);
  if (account.error || !account.data.user?.email) throw new Error("Acceptance owner metadata is unavailable.");
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
  if (link.error || !link.data.properties?.hashed_token) throw new Error("Issued acceptance login could not be created.");
  const verified = await publicClient.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "magiclink" });
  if (verified.error || !verified.data.session) throw new Error("Issued acceptance login could not be verified.");
  const context = await browser.newContext();
  await context.addCookies([{ name: `sb-${ACCEPTANCE_REF}-auth-token`,
    value: `base64-${Buffer.from(JSON.stringify(verified.data.session)).toString("base64url")}`,
    domain: "staging.crazy-loops.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  const resumeMarker = process.env.AUTOMATE_THIS_GMAIL_RESUME_MARKER;
  if (resumeMarker && !/^[0-9a-f]{12}$/.test(resumeMarker)) throw new Error("Invalid acceptance resume marker.");
  const marker = resumeMarker ?? randomUUID().replaceAll("-", "").slice(0, 12);
  const title = `Follow up on disposable acceptance request ${marker}`;
  const subject = `CrazyLoops acceptance follow-up ${marker}`;
  console.log("Live Gmail acceptance marker:", marker);
  let suggestionId: string | null = null;
  let workflowId: string | null = null;
  let futureId: string | null = null;
  try {
    await page.goto("/automations", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible();
    if (resumeMarker) {
      const prior = await admin.from("work_items").select("id,status")
        .eq("workspace_id", workspaceId).eq("assignee_user_id", ownerId)
        .eq("title", title).eq("status", "done");
      if (prior.error || prior.data.length !== 3) {
        throw new Error("The three completed follow-ups required for a safe resume are unavailable.");
      }
      const handoffs = await admin.from("automation_workbench_handoffs").select("id")
        .eq("workspace_id", workspaceId).eq("owner_user_id", ownerId)
        .in("work_item_id", prior.data.map((item) => item.id));
      if (handoffs.error || handoffs.data.length !== 3) {
        throw new Error("The three reviewed Workbench-to-Gmail handoffs required for a safe resume are unavailable.");
      }
      console.log("Live Gmail acceptance: resuming after three persisted provider-confirmed manual examples");
    } else {
    for (let index = 0; index < 3; index += 1) {
      console.log(`Live Gmail acceptance: manual follow-up ${index + 1} starting`);
      const item = await admin.from("work_items").insert({
        workspace_id: workspaceId, assignee_user_id: ownerId, title,
        summary: `Disposable acceptance request ${marker}, example ${index + 1}. A polite follow-up is appropriate.`,
        source_type: "internal", status: "needs_you", dedupe_key: `automate-this-gmail:${marker}:${index}`,
      }).select("id").single();
      if (item.error || !item.data) throw new Error("Disposable follow-up Work Item could not be created.");
      await page.goto(`/my-day/work/${item.data.id}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      await page.getByLabel("What should the draft focus on?").fill("Prepare a concise and polite follow-up for this disposable request. Use only the Work Item details; do not invent facts or claim anything was sent.");
      await page.getByRole("button", { name: "Create draft" }).click();
      await expect.poll(async () => {
        const turn = await admin.from("work_item_ai_turns").select("status").eq("work_item_id", item.data.id)
          .order("created_at", { ascending: false }).limit(1).maybeSingle();
        return turn.error?.code ?? turn.data?.status ?? "missing";
      }, { timeout: 90_000 }).toBe("completed");
      if (await page.getByRole("heading", { name: "Something went wrong" }).isVisible()) {
        throw new Error("Workbench AI completed but its browser transition failed.");
      }
      await page.goto(`/my-day/work/${item.data.id}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Save to task as draft" }).click();
      await expect(page.getByRole("button", { name: "Mark final" })).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Mark final" }).click();
      await expect(page.getByRole("button", { name: "Mark task complete" })).toBeVisible({ timeout: 30_000 });
      await page.getByText("Prepare an email from this result").click();
      const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Review email in Ask" }) });
      const body = `This is disposable CrazyLoops follow-up acceptance ${marker}-${index + 1}. No action is needed.`;
      await form.locator('input[name="recipient"]').fill(recipient);
      await form.locator('textarea[name="body"]').fill(body);
      await form.getByRole("button", { name: "Review email in Ask" }).click();
      await page.waitForURL((target) => target.pathname === "/ask" && Boolean(target.searchParams.get("thread")), {
        timeout: 90_000, waitUntil: "domcontentloaded",
      });
      const preview = await waitForAskPreview(page);
      await expect(preview).toContainText(recipient);
      await expect(preview).toContainText(body);
      await expect(preview).toContainText("Nothing has been sent or changed yet.");
      const handoff = await admin.from("automation_workbench_handoffs").select("id", { count: "exact" })
        .eq("workspace_id", workspaceId).eq("owner_user_id", ownerId).eq("work_item_id", item.data.id);
      if (handoff.error || handoff.count !== 1) throw new Error("Completed Workbench handoff provenance is missing.");
      await preview.getByRole("button", { name: "Review and request approval" }).click();
      await page.waitForURL((target) => target.pathname === "/my-day" && target.searchParams.get("action") === "pending_approval", {
        timeout: 30_000, waitUntil: "domcontentloaded",
      });
      const approval = page.getByRole("article").filter({ hasText: body });
      await expect(approval).toHaveCount(1);
      await expect(approval).toContainText(recipient);
      const approvalId = await approval.locator('input[name="id"]').inputValue();
      const before = await admin.from("action_executions").select("status,attempt_count")
        .eq("approval_request_id", approvalId).eq("workspace_id", workspaceId).eq("requester_user_id", ownerId).single();
      if (before.error || before.data.status !== "pending_approval" || before.data.attempt_count !== 0) {
        throw new Error("External action was attempted before exact approval.");
      }
      await approval.getByRole("button", { name: "Approve", exact: true }).click();
      await expect.poll(async () => {
        const result = await admin.from("action_executions").select("status")
          .eq("approval_request_id", approvalId).eq("requester_user_id", ownerId).single();
        return result.error?.code ?? result.data?.status ?? "missing";
      }, { timeout: 60_000 }).toBe("succeeded");
      const after = await admin.from("action_executions")
        .select("status,attempt_count,acknowledged,externally_delivered,provider_reference_id,connection_id")
        .eq("approval_request_id", approvalId).eq("requester_user_id", ownerId).single();
      if (after.error || after.data.attempt_count !== 1 || !after.data.acknowledged
        || !after.data.externally_delivered || !after.data.provider_reference_id
        || after.data.connection_id !== gmail[0].id) {
        throw new Error("Gmail did not durably acknowledge exactly one approved send.");
      }
      await page.goto(`/my-day/work/${item.data.id}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Mark task complete" }).click();
      await expect.poll(async () => {
        const result = await admin.from("work_items").select("status").eq("id", item.data.id).single();
        return result.error?.code ?? result.data?.status ?? "missing";
      }, { timeout: 30_000 }).toBe("done");
      console.log(`Live Gmail acceptance: manual follow-up ${index + 1} provider-confirmed`);
    }
    }
    await page.goto("/automations", { waitUntil: "domcontentloaded" });
    const suggestionCard = page.getByRole("article").filter({ hasText: title }).filter({ hasText: "Gmail follow-up" });
    await expect(suggestionCard).toHaveCount(1);
    await expect(suggestionCard).toContainText("3 completed examples");
    const existingSuggestion = await admin.from("automation_suggestions")
      .select("id,status,workflow_id").eq("workspace_id", workspaceId)
      .eq("owner_user_id", ownerId).eq("pattern_kind", "gmail_follow_up")
      .eq("source_title", title).single();
    if (existingSuggestion.error || !existingSuggestion.data) throw new Error("The exact Gmail suggestion is unavailable.");
    suggestionId = existingSuggestion.data.id;
    if (existingSuggestion.data.status === "active" && resumeMarker) {
      workflowId = existingSuggestion.data.workflow_id;
      if (!workflowId) throw new Error("Active acceptance suggestion has no published workflow.");
    } else if (existingSuggestion.data.status === "suggested") {
      await suggestionCard.getByRole("link", { name: "Automate this" }).click();
      await page.waitForURL((target) => /^\/automations\/[0-9a-f-]{36}$/.test(target.pathname));
      if (new URL(page.url()).pathname.split("/").at(-1) !== suggestionId) throw new Error("Wrong Gmail suggestion opened.");
      await page.getByLabel("Wait at least this many days").fill("1");
      await page.getByLabel("Your Gmail account").selectOption(gmail[0].id);
      await page.getByLabel("Exact recipient").fill(recipient);
      await page.getByLabel("Email subject").fill(subject);
      await page.getByLabel("What should the draft do?").fill("Write a polite follow-up under 200 characters using only this disposable Work Item. Do not claim an email was sent or invent facts.");
      await page.getByRole("button", { name: "Save for review" }).click();
      await expect(page.getByRole("button", { name: "Activate reviewed draft" })).toBeVisible();
      await page.getByRole("button", { name: "Activate reviewed draft" }).click();
    } else throw new Error("Gmail suggestion is in an unexpected state; no activation will be repeated.");
    await expect.poll(async () => {
      const row = await admin.from("automation_suggestions").select("status,workflow_id")
        .eq("id", suggestionId).eq("workspace_id", workspaceId).single();
      workflowId = row.data?.workflow_id ?? null;
      return row.error?.code ?? row.data?.status ?? "missing";
    }, { timeout: 30_000 }).toBe("active");
    if (!workflowId) throw new Error("The accepted suggestion did not create a workflow.");
    const running = await admin.from("automation_work_item_runs").select("id", { count: "exact", head: true }).eq("status", "running");
    if (running.error || running.count !== 0) throw new Error("Other running automations prevent a safely isolated clock test.");
    const active = await admin.from("automation_suggestions").select("id", { count: "exact", head: true }).eq("status", "active");
    if (active.error || active.count !== 1) throw new Error("Other active automations prevent a safely isolated clock test.");
    const futureKey = `automate-this-gmail:${marker}:future`;
    const existingFuture = await admin.from("work_items").select("id,status")
      .eq("workspace_id", workspaceId).eq("assignee_user_id", ownerId)
      .eq("dedupe_key", futureKey).maybeSingle();
    if (existingFuture.error) throw new Error("Disposable future Work Item could not be checked.");
    if (existingFuture.data && resumeMarker) {
      if (existingFuture.data.status !== "waiting") throw new Error("Existing acceptance Work Item is no longer waiting.");
      futureId = existingFuture.data.id;
    } else if (!existingFuture.data) {
      const future = await admin.from("work_items").insert({
        workspace_id: workspaceId, assignee_user_id: ownerId, title,
        summary: `Disposable future request ${marker}. Prepare only a polite follow-up; no invented facts.`,
        source_type: "internal", status: "waiting", due_at: new Date(Date.now() - 60_000).toISOString(),
        dedupe_key: futureKey,
      }).select("id").single();
      if (future.error || !future.data) throw new Error("Future matching Work Item could not be created.");
      futureId = future.data.id;
    } else throw new Error("Future Work Item already exists; refusing to create a duplicate.");
    const priorRun = await admin.from("automation_work_item_runs").select("status,attempt_count")
      .eq("suggestion_id", suggestionId).eq("work_item_id", futureId).maybeSingle();
    if (priorRun.error || (priorRun.data && (priorRun.data.status !== "pending" || priorRun.data.attempt_count !== 0))) {
      throw new Error("Existing automation run requires review before any retry.");
    }
    // The database claim enforces its own clock. Age only this disposable
    // acceptance fixture; no provider or security decision is mocked.
    const agedCreation = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const agedPublication = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const agedItem = await admin.from("work_items")
      .update({ created_at: agedCreation, due_at: agedCreation })
      .eq("id", futureId).eq("workspace_id", workspaceId).eq("assignee_user_id", ownerId)
      .eq("dedupe_key", futureKey).eq("status", "waiting").select("id").single();
    const agedWorkflow = await admin.from("workflows")
      .update({ published_at: agedPublication }).eq("id", workflowId)
      .eq("workspace_id", workspaceId).eq("user_id", ownerId)
      .eq("lifecycle_state", "active").select("id").single();
    if (agedItem.error || !agedItem.data || agedWorkflow.error || !agedWorkflow.data) {
      throw new Error("Disposable acceptance timestamps could not be aged safely.");
    }
    const metrics = dispatchAcceptanceFixture();
    if (metrics.claimed !== 1 || metrics.prepared !== 1 || metrics.failed !== 0) {
      throw new Error("Reviewed Gmail automation did not prepare one future follow-up.");
    }
    const runs = await admin.from("automation_work_item_runs").select("id,status,execution_id,attempt_count")
      .eq("suggestion_id", suggestionId).eq("work_item_id", futureId);
    if (runs.error || runs.data.length !== 1 || runs.data[0].status !== "succeeded"
      || runs.data[0].attempt_count !== 1 || !runs.data[0].execution_id) {
      throw new Error("The future Work Item did not have one durable prepared execution.");
    }
    const drafts = await admin.from("work_item_deliverables").select("id,status,ai_assisted")
      .eq("work_item_id", futureId);
    if (drafts.error || drafts.data.length !== 1 || drafts.data[0].status !== "draft" || !drafts.data[0].ai_assisted) {
      throw new Error("The future follow-up draft was not saved privately.");
    }
    const preparedApproval = await admin.from("action_executions").select("id,approval_request_id,status,attempt_count")
      .eq("workspace_id", workspaceId).eq("requester_user_id", ownerId)
      .eq("idempotency_key", `automation-action:${runs.data[0].execution_id}`)
      .eq("capability_id", "gmail_send_email").eq("status", "pending_approval").single();
    if (preparedApproval.error || !preparedApproval.data || preparedApproval.data.attempt_count !== 0) {
      throw new Error("The automation did not create one exact pending Gmail approval.");
    }
    await page.goto("/my-day", { waitUntil: "domcontentloaded" });
    const card = page.getByRole("article").filter({ hasText: subject });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(recipient);
    await expect(card).toContainText("Approval authorizes only the exact action shown");
    await expect(card.locator('input[name="id"]')).toHaveValue(preparedApproval.data.approval_request_id);
    await card.getByRole("button", { name: "Approve", exact: true }).click();
    await expect.poll(async () => {
      const row = await admin.from("action_executions").select("status").eq("id", preparedApproval.data.id).single();
      return row.error?.code ?? row.data?.status ?? "missing";
    }, { timeout: 60_000 }).toBe("succeeded");
    const sent = await admin.from("action_executions")
      .select("attempt_count,acknowledged,externally_delivered,provider_reference_id")
      .eq("id", preparedApproval.data.id).single();
    if (sent.error || sent.data.attempt_count !== 1 || !sent.data.acknowledged
      || !sent.data.externally_delivered || !sent.data.provider_reference_id) {
      throw new Error("Approved Gmail automation did not receive one durable provider acknowledgement.");
    }
    const replay = dispatchAcceptanceFixture();
    if (replay.claimed !== 0 || replay.prepared !== 0) throw new Error("Repeated trigger attempted another preparation.");
    const count = await admin.from("action_executions").select("id", { count: "exact", head: true })
      .eq("approval_request_id", preparedApproval.data.approval_request_id);
    if (count.error || count.count !== 1) throw new Error("Replay created another external action.");
    await page.goto(`/automations/${suggestionId}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Disable and archive" }).click();
    await expect.poll(async () => {
      const row = await admin.from("automation_suggestions").select("status").eq("id", suggestionId).single();
      return row.error?.code ?? row.data?.status ?? "missing";
    }, { timeout: 30_000 }).toBe("disabled");
    console.log("Live Gmail acceptance: exact approved automation send and replay checks passed");
  } finally {
    // Durable provider acknowledgements and Activity are retained for audit.
    // A failed run is never retried blindly; the marker identifies its scope.
    await context.close().catch(() => undefined);
    if (suggestionId && workflowId) {
      const current = await admin.from("automation_suggestions").select("status")
        .eq("id", suggestionId).eq("workspace_id", workspaceId).eq("owner_user_id", ownerId).maybeSingle();
      if (!current.error && current.data?.status === "active") {
        console.log("Live Gmail acceptance: active fixture requires review before another run");
      }
    }
    if (futureId) console.log("Live Gmail acceptance: future Work Item retained as durable evidence");
  }
});
