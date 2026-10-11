import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const ACCEPTANCE_REF = "gamdxwtgccluifatcrrs";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing acceptance configuration: ${name}`);
  return value;
}

test("a reviewed Workbench follow-up reaches an exact Gmail preview without sending", async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  if (process.env.AUTOMATE_THIS_GMAIL_ACCEPTANCE_ENABLED !== "true"
    || baseURL !== "https://staging.crazy-loops.com") throw new Error("Staging Gmail acceptance is not explicitly enabled.");
  const url = required("NEXT_PUBLIC_SUPABASE_URL");
  if (new URL(url).hostname !== `${ACCEPTANCE_REF}.supabase.co`) throw new Error("Wrong database target.");
  const admin = createClient(url, required("SUPABASE_SECRET_KEY"), { auth: { persistSession: false } });
  const publicClient = createClient(url, required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const connections = await admin.from("connector_connections")
    .select("id,user_id,workspace_id,external_account_label,granted_scopes")
    .eq("provider_family", "google").eq("status", "connected");
  if (connections.error) throw new Error("Acceptance connection metadata could not be read.");
  const gmail = connections.data.filter((row) => row.granted_scopes.includes("https://www.googleapis.com/auth/gmail.send"));
  if (gmail.length !== 1 || !gmail[0].external_account_label
    || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(gmail[0].external_account_label)) {
    throw new Error("Exactly one self-addressed acceptance Gmail connection is required.");
  }
  const owner = await admin.auth.admin.getUserById(gmail[0].user_id);
  if (owner.error || !owner.data.user?.email) throw new Error("Acceptance owner metadata is unavailable.");
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: owner.data.user.email });
  if (link.error || !link.data.properties?.hashed_token) throw new Error("Issued acceptance login could not be created.");
  const verified = await publicClient.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "magiclink" });
  if (verified.error || !verified.data.session) throw new Error("Issued acceptance login could not be verified.");
  const context = await browser.newContext();
  await context.addCookies([{ name: `sb-${ACCEPTANCE_REF}-auth-token`,
    value: `base64-${Buffer.from(JSON.stringify(verified.data.session)).toString("base64url")}`,
    domain: "staging.crazy-loops.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  const marker = randomUUID().replaceAll("-", "").slice(0, 12);
  const title = `Follow up on disposable acceptance request ${marker}`;
  const body = `A polite follow-up for CrazyLoops acceptance ${marker}. No customer action is needed.`;
  let workItemId: string | null = null;
  let threadId: string | null = null;
  let primaryFailure: unknown;
  let cleanupFailure: unknown;
  try {
    const item = await admin.from("work_items").insert({
      workspace_id: gmail[0].workspace_id, assignee_user_id: gmail[0].user_id,
      title, summary: `Disposable acceptance request ${marker}; prepare a polite follow-up without invented facts.`,
      source_type: "internal", status: "needs_you", dedupe_key: `automate-this-preview:${marker}`,
    }).select("id").single();
    if (item.error || !item.data) throw new Error("Disposable Work Item could not be created.");
    workItemId = item.data.id;
    await page.goto(`/my-day/work/${workItemId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await page.getByLabel("What should the draft focus on?").fill("Draft a concise, polite follow-up from this disposable Work Item. Do not invent facts or say anything was sent.");
    await page.getByRole("button", { name: "Create draft" }).click();
    await expect.poll(async () => {
      const state = await admin.from("work_item_ai_turns").select("status")
        .eq("work_item_id", workItemId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      return state.error?.code ?? state.data?.status ?? "missing";
    }, { timeout: 90_000 }).toBe("completed");
    if (await page.getByRole("heading", { name: "Something went wrong" }).isVisible()) {
      throw new Error("Create draft reached an application error boundary despite a completed AI turn.");
    }
    await page.goto(`/my-day/work/${workItemId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Latest AI draft" })).toBeVisible();
    await page.getByRole("button", { name: "Save to task as draft" }).click();
    await expect(page.getByRole("button", { name: "Mark final" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Mark final" }).click();
    await expect(page.getByRole("button", { name: "Mark task complete" })).toBeVisible({ timeout: 30_000 });
    await page.getByText("Prepare an email from this result").click();
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Review email in Ask" }) });
    await form.locator('input[name="recipient"]').fill(gmail[0].external_account_label);
    await form.locator('textarea[name="body"]').fill(body);
    await form.getByRole("button", { name: "Review email in Ask" }).click();
    await page.waitForURL((target) => target.pathname === "/ask" && Boolean(target.searchParams.get("thread")), {
      timeout: 90_000, waitUntil: "domcontentloaded",
    });
    threadId = new URL(page.url()).searchParams.get("thread");
    const preview = page.getByRole("region", { name: "Action preview" });
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(preview).toContainText(gmail[0].external_account_label);
    await expect(preview).toContainText(body);
    await expect(preview).toContainText("Nothing has been sent or changed yet.");
    const handoff = await admin.from("automation_workbench_handoffs").select("id", { count: "exact" })
      .eq("workspace_id", gmail[0].workspace_id).eq("owner_user_id", gmail[0].user_id)
      .eq("work_item_id", workItemId);
    if (handoff.error || handoff.count !== 1) throw new Error("Reviewed Gmail handoff provenance was not persisted once.");
  } catch (error) {
    primaryFailure = error;
  } finally {
    test.setTimeout(test.info().timeout + 60_000);
    await context.close().catch(() => undefined);
    if (threadId) {
      const removed = await admin.from("ask_threads").delete().eq("id", threadId)
        .eq("workspace_id", gmail[0].workspace_id).eq("user_id", gmail[0].user_id);
      if (removed.error) cleanupFailure ??= new Error(`Disposable Ask thread cleanup failed: ${removed.error.code}`);
    }
    if (workItemId) {
      const removed = await admin.from("work_items").delete().eq("id", workItemId)
        .eq("workspace_id", gmail[0].workspace_id).eq("assignee_user_id", gmail[0].user_id);
      if (removed.error) cleanupFailure ??= new Error(`Disposable Work Item cleanup failed: ${removed.error.code}`);
    }
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailure) throw cleanupFailure;
});
