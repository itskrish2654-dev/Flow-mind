import { randomBytes, randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

test.use({ trace: "off", video: "off", screenshot: "off" });
test.describe.configure({ mode: "serial" });

const ACCEPTANCE_REF = "gamdxwtgccluifatcrrs";
type User = { id: string; email: string; password: string; personalWorkspaceId: string };
let browserIdentity = 0;

function disposableClientIp() {
  browserIdentity += 1;
  return `198.51.100.${browserIdentity}`;
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing acceptance variable: ${name}`);
  return value;
}

function credentials(label: string) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  return { email: `company-${label}-${suffix}@example.com`, password: `Co!${randomBytes(24).toString("base64url")}aA8` };
}

async function login(page: Page, user: User, next = "/settings/company") {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email address").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Log in securely" }).click();
  await page.waitForURL((url) => url.pathname === new URL(next, "http://localhost").pathname, { timeout: 30_000 });
}

async function invite(page: Page, email: string, role: "admin" | "member") {
  await page.goto("/settings/company");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Role", { exact: true }).selectOption(role);
  await page.getByRole("button", { name: "Create invite" }).click();
  const input = page.getByLabel("Invitation link");
  await expect(input).toBeVisible();
  const link = await input.inputValue();
  expect(new URL(link).pathname).toBe("/invite/accept");
  expect(new URL(link).searchParams.get("token")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return link;
}

async function acceptInvite(page: Page, link: string) {
  await page.goto(link);
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await page.waitForURL(/\/my-day\?joined=1/, { timeout: 30_000 });
}

async function clientFor(url: string, key: string, user: User) {
  const client = createClient(url, key, { auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw error;
  return client;
}

async function provision(admin: SupabaseClient, label: string): Promise<User> {
  const login = credentials(label);
  const { data, error } = await admin.auth.admin.createUser({ email: login.email, password: login.password, email_confirm: true, user_metadata: { acceptance_run: "company-workspace-v1" } });
  if (error || !data.user) throw new Error(`Could not create ${label}.`);
  const { data: rows, error: workspaceError } = await admin.rpc("ensure_default_workspace", { p_user_id: data.user.id });
  if (workspaceError || !rows?.[0]?.workspace_id) throw new Error(`Could not bootstrap ${label}.`);
  return { id: data.user.id, ...login, personalWorkspaceId: rows[0].workspace_id };
}

async function pageFor(browser: Browser, user: User, next = "/settings/company") {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": disposableClientIp() } });
  const page = await context.newPage();
  await login(page, user, next);
  return { context, page };
}

test("company onboarding, permissions, invitation lifecycle, switching, and isolation", async ({ browser, baseURL }) => {
  test.setTimeout(600_000);
  if (!baseURL || !baseURL.startsWith("http://localhost:3000")) throw new Error("Acceptance must run on localhost:3000.");
  const url = requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key = requiredEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  const secret = requiredEnv("SUPABASE_SECRET_KEY");
  if (new URL(url).hostname.split(".")[0] !== ACCEPTANCE_REF) throw new Error("Wrong Supabase target.");
  const admin = createClient(url, secret, { auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false } });
  const users: User[] = [];
  const contexts: BrowserContext[] = [];
  const workspaceIds = new Set<string>();
  const tables = ["workspaces", "workspace_memberships", "workspace_invitations", "work_items", "approval_requests", "ask_threads", "ask_turns", "ask_messages"] as const;
  const count = async (table: typeof tables[number]) => {
    const { count: value, error } = await admin.from(table).select("*", { count: "exact", head: true });
    if (error || value === null) throw new Error(`Could not count ${table}.`);
    return value;
  };
  const baseline = Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await count(table)])));
  try {
    for (const label of ["owner", "admin", "member", "outsider", "removable", "expired", "concurrent"]) {
      const user = await provision(admin, label);
      users.push(user);
      workspaceIds.add(user.personalWorkspaceId);
    }
    const [owner, adminUser, member, outsider, removable, expiredUser, concurrentUser] = users;
    const ownerBrowser = await pageFor(browser, owner);
    contexts.push(ownerBrowser.context);

    await expect(ownerBrowser.page.getByRole("heading", { name: "Workspace settings" })).toBeVisible();
    await expect(ownerBrowser.page.getByText("You are an owner in this company workspace.")).toBeVisible();
    await ownerBrowser.page.getByLabel("Company name").fill("Acme Acceptance Company");
    await ownerBrowser.page.getByRole("button", { name: "Save name" }).click();
    await expect(ownerBrowser.page.getByText("Company name updated.")).toBeVisible();
    await ownerBrowser.page.reload();
    await expect(ownerBrowser.page.getByLabel("Company name")).toHaveValue("Acme Acceptance Company");

    const memberInvite = await invite(ownerBrowser.page, member.email, "member");
    const memberToken = new URL(memberInvite).searchParams.get("token")!;
    const { data: storedMemberInvite, error: storedInviteError } = await admin.from("workspace_invitations")
      .select("id,workspace_id,status,token_hash,intended_role").eq("normalized_email", member.email).single();
    if (storedInviteError || !storedMemberInvite) throw new Error("Member invitation was not persisted.");
    workspaceIds.add(storedMemberInvite.workspace_id);
    expect(storedMemberInvite.status).toBe("pending");
    expect(storedMemberInvite.intended_role).toBe("member");
    expect(storedMemberInvite.token_hash).not.toBe(memberToken);
    expect(storedMemberInvite.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const outsiderBrowser = await pageFor(browser, outsider, "/my-day");
    contexts.push(outsiderBrowser.context);
    await outsiderBrowser.page.goto(memberInvite);
    await outsiderBrowser.page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(outsiderBrowser.page.getByText(/invitation belongs to a different account/i)).toBeVisible();
    const { count: outsiderMembership } = await admin.from("workspace_memberships").select("*", { count: "exact", head: true }).eq("workspace_id", storedMemberInvite.workspace_id).eq("user_id", outsider.id);
    expect(outsiderMembership).toBe(0);
    expect((await admin.from("workspace_invitations").select("status").eq("id", storedMemberInvite.id).single()).data?.status).toBe("pending");

    const memberBrowser = await pageFor(browser, member, "/my-day");
    contexts.push(memberBrowser.context);
    await acceptInvite(memberBrowser.page, memberInvite);
    const { data: memberRows } = await admin.from("workspace_memberships").select("workspace_id,role,is_default").eq("user_id", member.id);
    expect(memberRows?.filter((row) => row.workspace_id === storedMemberInvite.workspace_id)).toHaveLength(1);
    expect(memberRows?.find((row) => row.workspace_id === storedMemberInvite.workspace_id)).toMatchObject({ role: "member", is_default: true });
    await memberBrowser.page.goto(memberInvite);
    await memberBrowser.page.getByRole("button", { name: "Accept invitation" }).click();
    await memberBrowser.page.waitForURL(/\/my-day\?joined=1/);
    expect((await admin.from("workspace_memberships").select("*", { count: "exact", head: true }).eq("workspace_id", storedMemberInvite.workspace_id).eq("user_id", member.id)).count).toBe(1);

    const adminInvite = await invite(ownerBrowser.page, adminUser.email, "admin");
    const adminBrowser = await pageFor(browser, adminUser, "/my-day");
    contexts.push(adminBrowser.context);
    await acceptInvite(adminBrowser.page, adminInvite);
    expect((await admin.from("workspace_memberships").select("role").eq("workspace_id", storedMemberInvite.workspace_id).eq("user_id", adminUser.id).single()).data?.role).toBe("admin");

    await ownerBrowser.page.goto("/settings/company");
    const memberRow = ownerBrowser.page.locator("section").filter({ hasText: "Members" }).locator("div.py-4").filter({ hasText: member.email });
    await memberRow.getByLabel(`Role for ${member.email}`).selectOption("admin");
    await memberRow.getByRole("button", { name: "Update" }).click();
    await expect.poll(async () => (await admin.from("workspace_memberships").select("role").eq("workspace_id", storedMemberInvite.workspace_id).eq("user_id", member.id).single()).data?.role).toBe("admin");
    await ownerBrowser.page.reload();
    const promotedRow = ownerBrowser.page.locator("section").filter({ hasText: "Members" }).locator("div.py-4").filter({ hasText: member.email });
    await promotedRow.getByLabel(`Role for ${member.email}`).selectOption("member");
    await promotedRow.getByRole("button", { name: "Update" }).click();
    await expect.poll(async () => (await admin.from("workspace_memberships").select("role").eq("workspace_id", storedMemberInvite.workspace_id).eq("user_id", member.id).single()).data?.role).toBe("member");

    await adminBrowser.page.goto("/settings/company");
    await expect(adminBrowser.page.getByLabel("Role", { exact: true })).toHaveValue("member");
    await expect(adminBrowser.page.getByLabel("Role", { exact: true }).locator("option[value=admin]")).toHaveCount(0);
    const ownerRowForAdmin = adminBrowser.page.locator("section").filter({ hasText: "Members" }).locator("div.py-4").filter({ hasText: owner.email });
    await expect(ownerRowForAdmin.getByRole("button", { name: "Remove" })).toHaveCount(0);
    const adminClient = await clientFor(url, key, adminUser);
    expect((await adminClient.rpc("administer_workspace_member", { p_workspace_id: storedMemberInvite.workspace_id, p_actor_user_id: adminUser.id, p_target_user_id: owner.id, p_action: "remove", p_role: null })).error).toBeTruthy();
    const memberClient = await clientFor(url, key, member);
    expect((await memberClient.rpc("create_workspace_invitation", { p_workspace_id: storedMemberInvite.workspace_id, p_actor_user_id: member.id, p_invited_email: removable.email, p_intended_role: "member", p_token_hash: "a".repeat(64), p_expires_at: new Date(Date.now() + 86_400_000).toISOString() })).error).toBeTruthy();

    const removableInvite = await invite(adminBrowser.page, removable.email, "member");
    const removableBrowser = await pageFor(browser, removable, "/my-day"); contexts.push(removableBrowser.context);
    await acceptInvite(removableBrowser.page, removableInvite);
    await adminBrowser.page.goto("/settings/company");
    const removableRow = adminBrowser.page.locator("section").filter({ hasText: "Members" }).locator("div.py-4").filter({ hasText: removable.email });
    await removableRow.getByRole("button", { name: "Remove" }).click();
    await expect.poll(async () => (await admin.from("workspace_memberships").select("*", { count: "exact", head: true }).eq("workspace_id", storedMemberInvite.workspace_id).eq("user_id", removable.id)).count).toBe(0);

    const revokedInvite = await invite(ownerBrowser.page, expiredUser.email, "member");
    const revokedRecord = (await admin.from("workspace_invitations").select("id").eq("normalized_email", expiredUser.email).eq("status", "pending").single()).data!;
    const revokedRow = ownerBrowser.page.locator("section").filter({ hasText: "Invitations" }).locator("div.rounded-xl").filter({ hasText: expiredUser.email });
    await revokedRow.getByRole("button", { name: "Revoke" }).click();
    await expect.poll(async () => (await admin.from("workspace_invitations").select("status").eq("id", revokedRecord.id).single()).data?.status).toBe("revoked");
    const expiredBrowser = await pageFor(browser, expiredUser, "/my-day"); contexts.push(expiredBrowser.context);
    await expiredBrowser.page.goto(revokedInvite);
    await expect(expiredBrowser.page.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();

    const expiredInvite = await invite(ownerBrowser.page, expiredUser.email, "member");
    const expiredId = (await admin.from("workspace_invitations").select("id").eq("normalized_email", expiredUser.email).eq("status", "pending").single()).data!.id;
    const pastCreated = new Date(Date.now() - 172_800_000).toISOString();
    const pastExpiry = new Date(Date.now() - 86_400_000).toISOString();
    const { error: expireError } = await admin.from("workspace_invitations").update({ created_at: pastCreated, expires_at: pastExpiry }).eq("id", expiredId);
    if (expireError) throw expireError;
    await expiredBrowser.page.goto(expiredInvite);
    await expect(expiredBrowser.page.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();
    expect((await admin.from("workspace_invitations").select("status").eq("id", expiredId).single()).data?.status).toBe("expired");
    expect((await admin.from("workspace_memberships").select("*", { count: "exact", head: true }).eq("workspace_id", storedMemberInvite.workspace_id).eq("user_id", expiredUser.id)).count).toBe(0);

    const concurrentInvite = await invite(ownerBrowser.page, concurrentUser.email, "member");
    const concurrentOne = await pageFor(browser, concurrentUser, "/my-day"); contexts.push(concurrentOne.context);
    const concurrentTwo = await concurrentOne.context.newPage();
    await Promise.all([concurrentOne.page.goto(concurrentInvite), concurrentTwo.goto(concurrentInvite)]);
    await Promise.all([concurrentOne.page.getByRole("button", { name: "Accept invitation" }).click(), concurrentTwo.getByRole("button", { name: "Accept invitation" }).click()]);
    await Promise.all([concurrentOne.page.waitForURL(/\/my-day\?joined=1/), concurrentTwo.waitForURL(/\/my-day\?joined=1/)]);
    expect((await admin.from("workspace_memberships").select("*", { count: "exact", head: true }).eq("workspace_id", storedMemberInvite.workspace_id).eq("user_id", concurrentUser.id)).count).toBe(1);

    await memberBrowser.page.goto("/settings");
    await expect(memberBrowser.page.getByLabel("Active company")).toBeVisible();
    await memberBrowser.page.getByLabel("Active company").selectOption(member.personalWorkspaceId);
    await memberBrowser.page.getByRole("button", { name: "Switch" }).click();
    await memberBrowser.page.waitForURL(/\/my-day/);
    await expect.poll(async () => (await admin.from("workspace_memberships").select("workspace_id").eq("user_id", member.id).eq("is_default", true).single()).data?.workspace_id).toBe(member.personalWorkspaceId);
    await memberBrowser.page.goto("/settings");
    await memberBrowser.page.getByLabel("Active company").selectOption(storedMemberInvite.workspace_id);
    await memberBrowser.page.getByRole("button", { name: "Switch" }).click();
    await memberBrowser.page.waitForURL(/\/my-day/);

    const outsiderClient = await clientFor(url, key, outsider);
    const invitationsRead = await outsiderClient.from("workspace_invitations").select("*");
    expect(invitationsRead.error).toBeTruthy();
    expect(invitationsRead.data).toBeNull();
    expect((await outsiderClient.from("workspaces").select("id").eq("id", storedMemberInvite.workspace_id)).data).toEqual([]);
    expect((await outsiderClient.from("workspace_memberships").select("user_id").eq("workspace_id", storedMemberInvite.workspace_id)).data).toEqual([]);
    expect((await outsiderClient.from("work_items").select("id").eq("workspace_id", storedMemberInvite.workspace_id)).data).toEqual([]);
    expect((await outsiderClient.from("approval_requests").select("id").eq("workspace_id", storedMemberInvite.workspace_id)).data).toEqual([]);
    expect((await outsiderClient.from("ask_threads").select("id").eq("workspace_id", storedMemberInvite.workspace_id)).data).toEqual([]);
    expect((await outsiderClient.rpc("switch_active_workspace", { p_actor_user_id: outsider.id, p_workspace_id: storedMemberInvite.workspace_id })).error).toBeTruthy();

    await ownerBrowser.page.goto("/settings/company");
    const memberRemovalRow = ownerBrowser.page.locator("section").filter({ hasText: "Members" }).locator("div.py-4").filter({ hasText: member.email });
    await memberRemovalRow.getByRole("button", { name: "Remove" }).click();
    await expect.poll(async () => (await admin.from("workspace_memberships").select("*", { count: "exact", head: true }).eq("workspace_id", storedMemberInvite.workspace_id).eq("user_id", member.id)).count).toBe(0);
    await memberBrowser.page.goto("/my-day");
    await expect.poll(async () => (await admin.from("workspace_memberships").select("workspace_id").eq("user_id", member.id).eq("is_default", true).single()).data?.workspace_id).toBe(member.personalWorkspaceId);
    await memberBrowser.page.goto("/settings/company");
    await expect(memberBrowser.page.getByRole("heading", { name: "Workspace settings" })).toBeVisible();
    await expect(memberBrowser.page.getByLabel("Company name")).toHaveValue("My workspace");
    await expect(memberBrowser.page.locator("body")).not.toContainText("Acme Acceptance Company");
    await expect(memberBrowser.page.locator("body")).not.toContainText(owner.email);

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: { "x-forwarded-for": disposableClientIp() } }); contexts.push(mobile);
    const mobilePage = await mobile.newPage(); await login(mobilePage, owner);
    await expect(mobilePage.getByRole("heading", { name: "Workspace settings" })).toBeVisible();
    expect(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(mobilePage.locator("body")).not.toContainText(storedMemberInvite.token_hash);
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()));
    for (const workspaceId of workspaceIds) await admin.from("workspaces").delete().eq("id", workspaceId);
    for (const user of users) await admin.auth.admin.deleteUser(user.id);
    for (const table of tables) expect(await count(table), `${table} cleanup`).toBe(baseline[table]);
  }
});
