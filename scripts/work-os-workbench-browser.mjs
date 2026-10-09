import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "@playwright/test";

const raw = await readFile(process.env.CRAZYLOOPS_ACCEPTANCE_ENV_FILE ?? new URL("../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(raw.split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
  .map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1).replace(/^['"]|['"]$/g, "")]; }));
assert.equal(new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname, "gamdxwtgccluifatcrrs.supabase.co");
const origin = process.env.WORKBENCH_ACCEPTANCE_ORIGIN ?? "http://localhost:3100";
assert.ok(["localhost", "staging.crazy-loops.com"].includes(new URL(origin).hostname));
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });
const browser = await chromium.launch({ headless: true });
const tables = ["workspaces", "workspace_memberships", "goals", "goal_plans", "goal_plan_items",
  "work_items", "work_item_ai_turns", "work_item_deliverables", "activity_events",
  "knowledge_documents", "knowledge_chunks"];
const created = { users: [], workspaces: [], knowledgePath: null, knowledgeId: null };
let baseline = {};
let cleanupPassed = true;
const results = [];

async function checked(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.code ?? "unavailable"}`);
  return result.data;
}
async function count(table) {
  const { count: value, error } = await admin.from(table).select("*", { head: true, count: "exact" });
  if (error) throw new Error(`Count unavailable: ${table}`);
  return value;
}
async function account() {
  const value = { email: `workbench-${randomUUID()}@example.com`, password: randomBytes(30).toString("base64url") };
  const data = await checked(await admin.auth.admin.createUser({ email: value.email,
    password: value.password, email_confirm: true }), "create disposable account");
  value.id = data.user.id;
  created.users.push(value.id);
  const membership = await checked(await admin.rpc("ensure_default_workspace", { p_user_id: value.id }), "bootstrap workspace");
  value.workspaceId = membership[0].workspace_id;
  created.workspaces.push(value.workspaceId);
  return value;
}
async function join(value, workspaceId) {
  await checked(await admin.from("workspace_memberships").delete()
    .eq("workspace_id", value.workspaceId).eq("user_id", value.id), "remove initial membership");
  await checked(await admin.from("workspaces").delete().eq("id", value.workspaceId), "remove initial workspace");
  created.workspaces = created.workspaces.filter((id) => id !== value.workspaceId);
  await checked(await admin.from("workspace_memberships").insert({ workspace_id: workspaceId,
    user_id: value.id, role: "member", is_default: true }), "join test workspace");
  value.workspaceId = workspaceId;
}
async function login(value, viewport = { width: 1280, height: 850 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", () => errors.push("page error"));
  const cookies = new Map();
  const client = createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { isSingleton: false,
      auth: { autoRefreshToken: false, detectSessionInUrl: false },
      cookies: { getAll: () => [...cookies.entries()].map(([name, cookie]) => ({ name, value: cookie.value })),
        setAll: (items) => { for (const item of items) cookies.set(item.name, item); } },
    });
  const session = await checked(await client.auth.signInWithPassword({ email: value.email,
    password: value.password }), "issued browser session");
  await context.addCookies([...cookies.values()].filter((cookie) => cookie.value).map((cookie) => ({
    name: cookie.name, value: cookie.value, url: origin, sameSite: "Lax",
  })));
  return { context, page, errors, accessToken: session.session.access_token };
}
async function dataApi(session, table, id) {
  const response = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${table}?id=eq.${id}&select=id,status`, {
    headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${session.accessToken}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

try {
  for (const table of tables) baseline[table] = await count(table);
  const manager = await account();
  const employeeA = await account();
  const employeeB = await account();
  const outsider = await account();
  await join(employeeA, manager.workspaceId);
  await join(employeeB, manager.workspaceId);
  const [managerSession, aSession, bSession, outsiderSession] = await Promise.all([
    login(manager), login(employeeA), login(employeeB), login(outsider),
  ]);
  const knowledgeText = "Acme launch comparison source: Northstar is positioned for small teams with a monthly plan. Southbank emphasizes enterprise reporting. Elmbridge emphasizes implementation support. No verified pricing figures are available.";
  await managerSession.page.goto(`${origin}/knowledge`);
  await managerSession.page.locator("#knowledge-file").setInputFiles({ name: "Acme launch source.txt",
    mimeType: "text/plain", buffer: Buffer.from(knowledgeText) });
  await managerSession.page.getByRole("button", { name: "Upload", exact: true }).click();
  await managerSession.page.getByRole("status").getByText("Document indexed and ready for Ask.").waitFor({ timeout: 60_000 });
  const digest = createHash("sha256").update(knowledgeText).digest("hex");
  const document = await checked(await admin.from("knowledge_documents").select("id,storage_path")
    .eq("workspace_id", manager.workspaceId).eq("sha256", digest).single(), "company source");
  created.knowledgeId = document.id;
  created.knowledgePath = document.storage_path;

  const goal = await checked(await admin.from("goals").insert({ workspace_id: manager.workspaceId,
    created_by_user_id: manager.id, owner_user_id: manager.id, last_actor_user_id: manager.id,
    request_key: randomUUID(), request_hash: "a".repeat(64), title: "Prepare Acme launch brief",
    description: "Prepare a grounded launch brief and manager update.",
    success_criteria: "Research and manager update are complete and reviewable." }).select("id").single(), "goal fixture");
  const plan = await checked(await admin.from("goal_plans").insert({ workspace_id: manager.workspaceId,
    goal_id: goal.id, revision: 1, status: "approved", origin: "manager",
    proposed_by_user_id: manager.id, approved_by_user_id: manager.id,
    approved_at: new Date().toISOString() }).select("id").single(), "approved plan fixture");
  const planItems = await checked(await admin.from("goal_plan_items").insert([
    { workspace_id: manager.workspaceId, goal_id: goal.id, plan_id: plan.id, position: 1,
      title: "Research three competitors", description: "Compare positioning and audience, and flag missing pricing evidence.",
      rationale: "Ground the launch brief in available company evidence.", assignee_user_id: employeeA.id },
    { workspace_id: manager.workspaceId, goal_id: goal.id, plan_id: plan.id, position: 2,
      title: "Prepare launch update", description: "Draft a concise manager-facing launch update from approved Goal progress.",
      rationale: "Give management a clear status and remaining work.", assignee_user_id: employeeB.id },
  ]).select("id,assignee_user_id"), "approved plan items");
  await checked(await admin.from("goals").update({ current_plan_id: plan.id, approved_plan_id: plan.id,
    status: "active", activated_at: new Date().toISOString() }).eq("id", goal.id), "activate goal fixture");
  const items = await checked(await admin.from("work_items").insert(planItems.map((entry) => ({
    workspace_id: manager.workspaceId, assignee_user_id: entry.assignee_user_id,
    goal_id: goal.id, goal_plan_item_id: entry.id,
    title: entry.assignee_user_id === employeeA.id ? "Research three competitors" : "Prepare launch update",
    status: "needs_you", source_type: "internal", summary: "Use authorized Acme launch context.",
  }))).select("id,assignee_user_id"), "assigned work fixtures");
  const aItem = items.find((entry) => entry.assignee_user_id === employeeA.id);
  const bItem = items.find((entry) => entry.assignee_user_id === employeeB.id);
  assert.ok(aItem && bItem);

  await aSession.page.goto(`${origin}/my-day`);
  await aSession.page.locator(`#work-item-${aItem.id}`).waitFor();
  await aSession.page.locator(`#work-item-${aItem.id}`).getByRole("link", { name: "Do with AI" }).click();
  await aSession.page.getByRole("heading", { name: "Research three competitors" }).waitFor();
  await aSession.page.getByRole("button", { name: "Create draft" }).click();
  await aSession.page.getByText("Latest AI draft").waitFor({ timeout: 90_000 });
  const aTurn = await checked(await admin.from("work_item_ai_turns").select("id,status,mode,response_content,source_references")
    .eq("work_item_id", aItem.id).single(), "real research AI turn");
  assert.equal(aTurn.status, "completed");
  assert.equal(aTurn.mode, "RESEARCH");
  assert.match(aTurn.response_content, /Northstar|Southbank|Elmbridge/i);
  assert.ok(aTurn.source_references.some((entry) => entry.documentId === document.id));
  results.push("REAL_AI_RESEARCH_GROUNDED_COMPANY_SOURCE=PASS");
  await aSession.page.getByRole("button", { name: "Save to task as draft" }).click();
  await aSession.page.waitForURL(/result=(saved|save_failed)/);
  assert.equal(new URL(aSession.page.url()).searchParams.get("result"), "saved");
  const aDraft = await checked(await admin.from("work_item_deliverables").select("id,status")
    .eq("work_item_id", aItem.id).single(), "saved research revision");
  assert.equal(aDraft.status, "draft");
  await aSession.page.getByRole("button", { name: "Mark final" }).click();
  await aSession.page.waitForURL(/result=(finalized|finalize_failed)/);
  assert.equal(new URL(aSession.page.url()).searchParams.get("result"), "finalized");
  await aSession.page.getByRole("button", { name: "Mark task complete" }).click();
  await aSession.page.waitForURL(/result=(completed|complete_failed)/);
  assert.equal(new URL(aSession.page.url()).searchParams.get("result"), "completed");
  const completedA = await checked(await admin.from("work_items").select("status")
    .eq("id", aItem.id).single(), "completed research work");
  assert.equal(completedA.status, "done");
  results.push("REVIEW_SAVE_FINALIZE_COMPLETE=PASS");

  await managerSession.page.goto(`${origin}/goals/${goal.id}`);
  await managerSession.page.getByRole("heading", { name: "Final team work" }).waitFor();
  await managerSession.page.getByText("Research three competitors", { exact: false }).first().waitFor();
  assert.equal(await dataApi(managerSession, "work_item_ai_turns", aTurn.id).then((rows) => rows.length), 0);
  assert.equal(await dataApi(bSession, "work_item_ai_turns", aTurn.id).then((rows) => rows.length), 0);
  assert.equal(await dataApi(outsiderSession, "work_item_deliverables", aDraft.id).then((rows) => rows.length), 0);
  await outsiderSession.page.goto(`${origin}/my-day/work/${aItem.id}`);
  assert.equal(await outsiderSession.page.getByRole("heading", { name: "Research three competitors" }).count(), 0);
  results.push("MANAGER_FINAL_PRIVATE_SCRATCH_CROSS_USER_AND_TENANT_DENIAL=PASS");

  await bSession.page.goto(`${origin}/my-day/work/${bItem.id}`);
  await bSession.page.getByRole("button", { name: "Create draft" }).click();
  await bSession.page.getByText("Latest AI draft").waitFor({ timeout: 90_000 });
  const bTurn = await checked(await admin.from("work_item_ai_turns").select("id,status,mode")
    .eq("work_item_id", bItem.id).single(), "real writing AI turn");
  assert.equal(bTurn.status, "completed");
  assert.equal(bTurn.mode, "WRITING");
  await bSession.page.getByRole("button", { name: "Save to task as draft" }).click();
  await bSession.page.waitForURL(/result=(saved|save_failed)/);
  assert.equal(new URL(bSession.page.url()).searchParams.get("result"), "saved");
  await bSession.page.getByRole("button", { name: "Mark final" }).click();
  await bSession.page.waitForURL(/result=(finalized|finalize_failed)/);
  assert.equal(new URL(bSession.page.url()).searchParams.get("result"), "finalized");
  await bSession.page.getByRole("button", { name: "Mark task complete" }).click();
  await bSession.page.waitForURL(/result=(completed|complete_failed)/);
  assert.equal(new URL(bSession.page.url()).searchParams.get("result"), "completed");
  const work = await checked(await admin.from("work_items").select("status")
    .eq("goal_id", goal.id), "goal progress");
  assert.ok(work.every((entry) => entry.status === "done"));
  await managerSession.page.reload();
  await managerSession.page.getByRole("heading", { name: "Final team work" }).waitFor();
  results.push("REAL_AI_WRITING_GOAL_PROGRESS_MANAGER_RESULTS=PASS");

  const activity = await checked(await admin.from("activity_events").select("event_type,visibility")
    .eq("workspace_id", manager.workspaceId).eq("goal_id", goal.id), "goal Activity");
  assert.ok(activity.some((entry) => entry.event_type === "work_result_finalized" && entry.visibility === "workspace"));
  assert.ok(activity.some((entry) => entry.event_type === "work_item_done"));
  const mobile = await login(employeeA, { width: 390, height: 844 });
  await mobile.page.goto(`${origin}/my-day/work/${aItem.id}`);
  await mobile.page.getByRole("heading", { name: "Do with AI" }).waitFor();
  assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await mobile.context.close();
  assert.equal([managerSession, aSession, bSession, outsiderSession].flatMap((entry) => entry.errors).length, 0);
  results.push("ACTIVITY_DESKTOP_MOBILE_NO_BROWSER_ERRORS=PASS");
  console.log(results.join("\n"));
} finally {
  if (created.knowledgeId) {
    const { error } = await admin.from("knowledge_documents").delete().eq("id", created.knowledgeId);
    if (error) cleanupPassed = false;
  }
  if (created.knowledgePath) {
    const { error } = await admin.storage.from("company_knowledge").remove([created.knowledgePath]);
    if (error) cleanupPassed = false;
  }
  for (const workspaceId of created.workspaces.reverse()) {
    const { error } = await admin.from("workspaces").delete().eq("id", workspaceId);
    if (error) cleanupPassed = false;
  }
  for (const userId of created.users.reverse()) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) cleanupPassed = false;
  }
  await browser.close();
  for (const [table, before] of Object.entries(baseline)) {
    try { if (await count(table) !== before) cleanupPassed = false; }
    catch { cleanupPassed = false; }
  }
  console.log(`CLEANUP=${cleanupPassed ? "PASS" : "FAIL"}`);
  if (!cleanupPassed) process.exitCode = 1;
}
