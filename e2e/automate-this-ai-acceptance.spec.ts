import { randomBytes, randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

test.use({ trace: "off", screenshot: "off", video: "off" });
test.describe.configure({ mode: "serial" });

const ACCEPTANCE_REF = "gamdxwtgccluifatcrrs";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing acceptance configuration: ${name}`);
  return value;
}

test("reviewed AI automation prepares one real provider result for a future Work Item", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  if (process.env.AUTOMATE_THIS_ACCEPTANCE_ENABLED !== "true"
    || baseURL !== "https://staging.crazy-loops.com") throw new Error("Staging acceptance is not explicitly enabled.");
  const url = required("NEXT_PUBLIC_SUPABASE_URL");
  if (new URL(url).hostname !== `${ACCEPTANCE_REF}.supabase.co`) throw new Error("Wrong database target.");
  const admin = createClient(url, required("SUPABASE_SECRET_KEY"), {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const marker = randomUUID().replaceAll("-", "").slice(0, 16);
  const title = `Prepare manager status update ${marker}`;
  const users: Array<{ id: string; workspaceId: string }> = [];
  const browserContexts = [];
  let testFailure: unknown;
  let cleanupFailure: unknown;
  try {
    for (const role of ["owner", "outsider"]) {
      const email = `automate-this-${role}-${marker}@example.com`;
      const password = `At!${randomBytes(24).toString("base64url")}7z`;
      const created = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { acceptance_run: `automate-this-${marker}` },
      });
      if (created.error || !created.data.user) throw new Error("Disposable user creation failed.");
      const workspace = await admin.rpc("ensure_default_workspace", { p_user_id: created.data.user.id });
      const workspaceId = workspace.data?.[0]?.workspace_id;
      if (workspace.error || !workspaceId) throw new Error("Disposable workspace creation failed.");
      users.push({ id: created.data.user.id, workspaceId });
      const context = await browser.newContext({ viewport: { width: role === "owner" ? 1365 : 390, height: 850 } });
      browserContexts.push(context);
      const page = await context.newPage();
      await page.goto("/login?next=/automations");
      await page.getByLabel("Email address").fill(email);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Log in securely" }).click();
      await page.waitForURL(/\/(dashboard|automations)(?:$|[/?#])/, { timeout: 30_000 });
    }
    const owner = users[0];
    const ownerPage = browserContexts[0].pages()[0];
    const outsiderPage = browserContexts[1].pages()[0];
    for (let index = 0; index < 3; index += 1) {
      const item = await admin.from("work_items").insert({
        workspace_id: owner.workspaceId, assignee_user_id: owner.id,
        title, summary: `Completed disposable manager update example ${index + 1}.`,
        source_type: "internal", status: "done", resolved_at: new Date().toISOString(),
      }).select("id").single();
      if (item.error || !item.data) throw new Error("Example Work Item fixture failed.");
      const deliverable = await admin.from("work_item_deliverables").insert({
        workspace_id: owner.workspaceId, owner_user_id: owner.id, work_item_id: item.data.id,
        request_key: randomUUID(), title: `Manager update example ${index + 1}`,
        content: `A disposable reviewed manager update example ${index + 1}.`,
        ai_assisted: true, status: "final", finalized_at: new Date().toISOString(),
      });
      if (deliverable.error) throw new Error("Example deliverable fixture failed.");
    }
    await ownerPage.goto("/automations");
    await expect(ownerPage.getByRole("heading", { name: "Automations" })).toBeVisible();
    const suggestionCard = ownerPage.getByRole("article").filter({ hasText: title });
    await expect(suggestionCard).toHaveCount(1);
    await expect(suggestionCard).toContainText("3 completed examples");
    await suggestionCard.getByRole("link", { name: "Automate this" }).click();
    const suggestionId = new URL(ownerPage.url()).pathname.split("/").at(-1);
    if (!suggestionId) throw new Error("Suggestion URL was unavailable.");
    await outsiderPage.goto(`/automations/${suggestionId}`);
    await expect(outsiderPage.getByText(title)).toHaveCount(0);
    await ownerPage.getByRole("button", { name: "Save for review" }).click();
    await expect(ownerPage.getByRole("button", { name: "Activate reviewed draft" })).toBeVisible();
    await ownerPage.getByRole("button", { name: "Activate reviewed draft" }).click();
    await expect(ownerPage.getByText(/Current state: active\./)).toBeVisible();
    const future = await admin.from("work_items").insert({
      workspace_id: owner.workspaceId, assignee_user_id: owner.id,
      title, summary: "Prepare a concise manager update on the disposable pilot work. No external actions.",
      source_type: "internal", status: "needs_you",
    }).select("id").single();
    if (future.error || !future.data) throw new Error("Future Work Item fixture failed.");
    const dispatch = await fetch(`${baseURL}/api/operations/schedules`, {
      method: "POST", headers: { authorization: `Bearer ${required("SCHEDULE_DISPATCH_SECRET")}` },
    });
    if (!dispatch.ok) throw new Error(`Staging dispatch returned HTTP ${dispatch.status}.`);
    const { data: runs, error: runError } = await admin.from("automation_work_item_runs").select("id,status,execution_id,attempt_count")
      .eq("workspace_id", owner.workspaceId).eq("work_item_id", future.data.id);
    if (runError || runs.length !== 1 || runs[0].status !== "succeeded" || runs[0].attempt_count !== 1 || !runs[0].execution_id) {
      throw new Error("The real AI automation did not complete exactly once.");
    }
    const { data: execution, error: executionError } = await admin.from("workflow_executions")
      .select("status,output_data").eq("id", runs[0].execution_id).single();
    if (executionError || execution.status !== "succeeded"
      || !execution.output_data || typeof execution.output_data !== "object"
      || !Array.isArray(execution.output_data.ai_metadata) || !execution.output_data.ai_metadata.length) {
      throw new Error("The AI provider result was not durably recorded.");
    }
    const { data: drafts, error: draftError } = await admin.from("work_item_deliverables")
      .select("id,status,ai_assisted").eq("work_item_id", future.data.id);
    if (draftError || drafts.length !== 1 || drafts[0].status !== "draft" || !drafts[0].ai_assisted) {
      throw new Error("The prepared Work Item draft was not saved privately.");
    }
    await ownerPage.goto("/my-day");
    await expect(ownerPage.getByText(title).first()).toBeVisible();
    const repeat = await fetch(`${baseURL}/api/operations/schedules`, {
      method: "POST", headers: { authorization: `Bearer ${required("SCHEDULE_DISPATCH_SECRET")}` },
    });
    if (!repeat.ok) throw new Error("The idempotency dispatch check failed.");
    const { count, error: countError } = await admin.from("automation_work_item_runs")
      .select("id", { count: "exact", head: true }).eq("workspace_id", owner.workspaceId).eq("work_item_id", future.data.id);
    if (countError || count !== 1) throw new Error("Dispatch replay created another automation run.");
    await ownerPage.setViewportSize({ width: 390, height: 844 });
    await ownerPage.goto("/automations");
    await expect(ownerPage.getByRole("heading", { name: "Automations" })).toBeVisible();
    await expect(ownerPage.getByRole("article").filter({ hasText: title })).toBeVisible();
  } catch (error) {
    testFailure = error;
  } finally {
    for (const context of browserContexts) await context.close();
    for (const user of users.reverse()) {
      try {
        const workflows = await admin.from("workflows").select("id")
          .eq("workspace_id", user.workspaceId).eq("user_id", user.id);
        if (workflows.error) throw new Error("Disposable workflow cleanup scope failed.");
        for (const workflow of workflows.data) {
          const removedWorkflow = await admin.from("workflows").delete().eq("id", workflow.id)
            .eq("workspace_id", user.workspaceId).eq("user_id", user.id);
          if (removedWorkflow.error) throw new Error(`Disposable workflow cleanup failed: ${removedWorkflow.error.code}`);
        }
        const removedWorkspace = await admin.from("workspaces").delete().eq("id", user.workspaceId)
          .eq("created_by", user.id);
        if (removedWorkspace.error) throw new Error(`Disposable workspace cleanup failed: ${removedWorkspace.error.code}`);
        const removedUser = await admin.auth.admin.deleteUser(user.id);
        if (removedUser.error) throw new Error("Disposable user cleanup failed.");
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
  }
  if (testFailure) throw testFailure;
  if (cleanupFailure) throw cleanupFailure;
});
