import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "@playwright/test";

const raw = await readFile(new URL("../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(raw.split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
  .map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1).replace(/^['"]|['"]$/g, "")]; }));
assert.equal(new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname, "gamdxwtgccluifatcrrs.supabase.co");
assert.equal(new URL(env.NEXT_PUBLIC_SITE_URL).hostname, "localhost");
assert.ok(env.GROQ_API_KEY, "Real planning and Ask require the configured provider");
const origin = env.NEXT_PUBLIC_SITE_URL;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });
const browser = await chromium.launch({ headless: true });
const tables = ["workspaces", "workspace_memberships", "goals", "goal_plans", "goal_plan_items",
  "work_items", "approval_requests", "ask_threads", "ask_messages", "ask_turns",
  "action_executions", "activity_events", "knowledge_documents", "knowledge_chunks"];
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
async function createAccount() {
  const account = { email: `goals-${randomUUID()}@example.com`, password: randomBytes(30).toString("base64url") };
  const data = await checked(await admin.auth.admin.createUser({ email: account.email,
    password: account.password, email_confirm: true }), "create disposable account");
  account.id = data.user.id;
  created.users.push(account.id);
  const membership = await checked(await admin.rpc("ensure_default_workspace", { p_user_id: account.id }), "bootstrap workspace");
  account.workspaceId = membership[0].workspace_id;
  created.workspaces.push(account.workspaceId);
  return account;
}
async function joinAccount(account, workspaceId, role) {
  await checked(await admin.from("workspace_memberships").delete()
    .eq("workspace_id", account.workspaceId).eq("user_id", account.id), "remove initial membership");
  await checked(await admin.from("workspaces").delete().eq("id", account.workspaceId), "remove initial workspace");
  created.workspaces = created.workspaces.filter((id) => id !== account.workspaceId);
  await checked(await admin.from("workspace_memberships").insert({ workspace_id: workspaceId,
    user_id: account.id, role, is_default: true }), "join test workspace");
  account.workspaceId = workspaceId;
}
async function login(account, viewport = { width: 1280, height: 850 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", () => errors.push("browser page error"));
  const cookies = new Map();
  const client = createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { isSingleton: false,
      auth: { autoRefreshToken: false, detectSessionInUrl: false },
      cookies: { getAll: () => [...cookies.entries()].map(([name, cookie]) => ({ name, value: cookie.value })),
        setAll: (items) => { for (const item of items) cookies.set(item.name, item); } },
    });
  const session = await checked(await client.auth.signInWithPassword({ email: account.email,
    password: account.password }), "issued browser session");
  await context.addCookies([...cookies.values()].filter((cookie) => cookie.value).map((cookie) => ({
    name: cookie.name, value: cookie.value, url: origin, sameSite: "Lax",
  })));
  return { context, page, errors, accessToken: session.session.access_token };
}
async function dataApi(browserSession, path, options = {}) {
  return fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${browserSession.accessToken}`, "Content-Type": "application/json",
      ...options.headers },
  });
}
async function addKnowledge(owner) {
  const content = Buffer.from("Customer support hiring procedure: the recruitment manager reviews the final role description before publishing. Interview notes must be reviewed before a written offer is sent. Written offer acceptance confirms each hire.");
  const documentId = randomUUID();
  const path = `${owner.workspaceId}/${documentId}/Hiring-SOP.txt`;
  await checked(await admin.storage.from("company_knowledge").upload(path, content,
    { contentType: "text/plain", upsert: false }), "upload synthetic SOP");
  created.knowledgePath = path;
  await checked(await admin.from("knowledge_documents").insert({ id: documentId,
    workspace_id: owner.workspaceId, uploaded_by_user_id: owner.id,
    title: "Customer Support Hiring SOP", filename: "Hiring-SOP.txt", mime_type: "text/plain",
    size_bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex"),
    storage_path: path, status: "ready", character_count: content.length, chunk_count: 1,
  }), "index synthetic SOP");
  created.knowledgeId = documentId;
  await checked(await admin.from("knowledge_chunks").insert({ id: randomUUID(), workspace_id: owner.workspaceId,
    document_id: documentId, chunk_index: 0, content: content.toString("utf8") }), "index SOP chunk");
  return documentId;
}

try {
  for (const table of tables) baseline[table] = await count(table);
  assert.equal(baseline.goals, 0, "Goals baseline must be empty");
  const owner = await createAccount();
  const member = await createAccount();
  const outsider = await createAccount();
  await joinAccount(member, owner.workspaceId, "member");
  const knowledgeId = await addKnowledge(owner);
  const ownerBrowser = await login(owner);
  const memberBrowser = await login(member);
  const outsiderBrowser = await login(outsider);

  await ownerBrowser.page.goto(`${origin}/goals`);
  await ownerBrowser.page.getByRole("heading", { name: "Goals", exact: true }).waitFor();
  await ownerBrowser.page.getByText("No goals yet").waitFor();
  await ownerBrowser.page.getByRole("button", { name: "Create goal" }).click();
  await ownerBrowser.page.getByRole("textbox", { name: "Desired outcome" }).fill("Grow revenue across the company");
  await ownerBrowser.page.getByRole("button", { name: "Save draft goal" }).click();
  await ownerBrowser.page.waitForURL(/\/goals\/[0-9a-f-]{36}$/);
  const vagueGoalId = new URL(ownerBrowser.page.url()).pathname.split("/").at(-1);
  await ownerBrowser.page.getByRole("button", { name: "Propose plan with AI" }).click();
  await ownerBrowser.page.getByRole("status").getByText(/measurable outcome/i).waitFor();
  assert.equal((await checked(await admin.from("goal_plans").select("id")
    .eq("goal_id", vagueGoalId), "vague goal plans")).length, 0);
  assert.equal((await checked(await admin.from("work_items").select("id")
    .eq("goal_id", vagueGoalId), "vague goal work")).length, 0);
  results.push("VAGUE_GOAL_CLARIFICATION_NO_GENERATED_WORK=PASS");
  await ownerBrowser.page.goto(`${origin}/goals`);
  await ownerBrowser.page.getByRole("button", { name: "Create goal" }).click();
  await ownerBrowser.page.getByRole("textbox", { name: "Desired outcome" }).fill("Hire 3 customer support agents by November 30");
  await ownerBrowser.page.getByRole("textbox", { name: "What does success look like?" })
    .fill("Three candidates have accepted written offers.");
  await ownerBrowser.page.getByRole("textbox", { name: /Context/ }).fill("Use the Customer Support Hiring SOP.");
  await ownerBrowser.page.getByRole("button", { name: "Save draft goal" }).click();
  await ownerBrowser.page.waitForURL(/\/goals\/[0-9a-f-]{36}$/);
  const goalId = new URL(ownerBrowser.page.url()).pathname.split("/").at(-1);
  const goal = await checked(await admin.from("goals").select("id,status,workspace_id")
    .eq("id", goalId).single(), "created goal");
  assert.equal(goal.workspace_id, owner.workspaceId);
  assert.equal(goal.status, "draft");
  assert.equal((await checked(await admin.from("work_items").select("id").eq("goal_id", goalId), "draft work")).length, 0);
  results.push("OWNER_CREATE_EMPTY_STATE_NO_PREAPPROVAL_WORK=PASS");

  await memberBrowser.page.goto(`${origin}/goals/${goalId}`);
  await memberBrowser.page.getByRole("heading", { name: /Hire 3 customer support agents/ }).waitFor();
  assert.equal(await memberBrowser.page.getByRole("heading", { name: "Manager controls" }).count(), 0);
  await outsiderBrowser.page.goto(`${origin}/goals/${goalId}`);
  assert.equal(await outsiderBrowser.page.getByRole("heading", { name: /Hire 3 customer support agents/ }).count(), 0);
  results.push("MEMBER_READ_NO_MANAGE_CROSS_WORKSPACE_DENIAL=PASS");

  await ownerBrowser.page.getByRole("button", { name: "Propose plan with AI" }).click();
  await ownerBrowser.page.waitForFunction(() => /Revision 1/.test(document.body.innerText)
    || Boolean(document.querySelector('[aria-label="Manage goal"] [role="status"]')), null, { timeout: 60_000 });
  const generationNotice = await ownerBrowser.page.locator('[role="status"]').allTextContents();
  assert.ok(await ownerBrowser.page.getByText(/Revision 1/).count() > 0,
    `AI plan did not persist: ${generationNotice.join(" ").slice(0, 180)}`);
  const firstPlan = await checked(await admin.from("goal_plans")
    .select("id,revision,status,origin,source_references").eq("goal_id", goalId).single(), "AI plan");
  const forgedRpc = await dataApi(memberBrowser, "rpc/activate_goal_plan", { method: "POST",
    body: JSON.stringify({ p_actor_user_id: member.id, p_goal_id: goalId,
      p_plan_id: firstPlan.id, p_expected_revision: firstPlan.revision }) });
  assert.ok([401, 403, 404].includes(forgedRpc.status), "member browser must not invoke activation RPC");
  const forgedInsert = await dataApi(memberBrowser, "goals", { method: "POST",
    body: JSON.stringify({ workspace_id: owner.workspaceId, title: "Forged manager goal" }) });
  assert.ok([401, 403].includes(forgedInsert.status), "member browser must not insert goals");
  const outsiderRead = await dataApi(outsiderBrowser, `goals?id=eq.${goalId}&select=id`);
  assert.equal(outsiderRead.status, 200);
  assert.deepEqual(await outsiderRead.json(), []);
  results.push("ISSUED_SESSION_RPC_MUTATION_AND_CROSS_WORKSPACE_DENIAL=PASS");
  assert.equal(firstPlan.origin, "ai_assisted");
  assert.ok(firstPlan.source_references.some((source) => source.documentId === knowledgeId),
    "AI proposal must cite the relevant company SOP");
  const initialItems = await checked(await admin.from("goal_plan_items").select("id,assignee_user_id")
    .eq("plan_id", firstPlan.id), "proposed items");
  assert.ok(initialItems.length > 0 && initialItems.length <= 12);
  assert.ok(initialItems.every((item) => item.assignee_user_id === null));
  assert.equal((await checked(await admin.from("work_items").select("id").eq("goal_id", goalId), "preapproval work")).length, 0);
  results.push("REAL_AI_STRUCTURED_KNOWLEDGE_GROUNDED_UNASSIGNED_PROPOSAL=PASS");

  await ownerBrowser.page.getByRole("button", { name: "Revise plan" }).click();
  const editor = ownerBrowser.page.locator('form').filter({ has: ownerBrowser.page.getByRole("button", { name: "Save proposal" }) });
  const titles = editor.getByRole("textbox", { name: "Work Item title" });
  await titles.first().fill("Finalize role description — manager reviewed");
  const assignees = editor.getByRole("combobox", { name: "Assignee" });
  for (let index = 0; index < await assignees.count(); index++)
    await assignees.nth(index).selectOption(index === 0 ? member.id : owner.id);
  await editor.getByRole("button", { name: "Save proposal" }).click();
  await ownerBrowser.page.getByText(/Revision 2/).waitFor({ timeout: 30_000 });
  const revised = await checked(await admin.from("goal_plans").select("id,status,revision")
    .eq("goal_id", goalId).eq("status", "proposed").single(), "revised proposal");
  assert.equal(revised.revision, 2);
  assert.equal((await checked(await admin.from("work_items").select("id").eq("goal_id", goalId), "revised preapproval work")).length, 0);
  results.push("MANAGER_EDIT_VERSIONING_NO_WORK=PASS");

  const secondTab = await ownerBrowser.context.newPage();
  await secondTab.goto(`${origin}/goals/${goalId}`);
  await secondTab.getByRole("button", { name: "Review exact plan for approval" }).waitFor();
  await ownerBrowser.page.getByRole("button", { name: "Review exact plan for approval" }).click();
  await ownerBrowser.page.getByRole("heading", { name: "Approve revision 2?" }).waitFor();
  assert.equal(await ownerBrowser.page.getByText("Finalize role description — manager reviewed").count() >= 1, true);
  await ownerBrowser.page.getByRole("button", { name: "Approve and create work" }).click();
  await ownerBrowser.page.getByText("2 of", { exact: false }).first().waitFor({ timeout: 30_000 }).catch(() => {});
  await ownerBrowser.page.getByRole("heading", { name: "Approved execution plan" }).waitFor({ timeout: 30_000 });
  await secondTab.getByRole("button", { name: "Review exact plan for approval" }).click();
  await secondTab.getByRole("button", { name: "Approve and create work" }).click();
  const linkedWork = await checked(await admin.from("work_items")
    .select("id,goal_plan_item_id,assignee_user_id,status")
    .eq("goal_id", goalId), "activated Work Items");
  assert.equal(linkedWork.length, initialItems.length);
  assert.equal(new Set(linkedWork.map((item) => item.goal_plan_item_id)).size, linkedWork.length);
  assert.equal((await checked(await admin.from("action_executions").select("id")
    .eq("workspace_id", owner.workspaceId), "external actions")).length, 0);
  results.push("EXACT_APPROVAL_TWO_TAB_ONE_ACTIVATION_NO_EXTERNAL_ACTION=PASS");

  await memberBrowser.page.goto(`${origin}/my-day`);
  await memberBrowser.page.getByRole("heading", { name: "Finalize role description — manager reviewed" }).waitFor();
  const card = memberBrowser.page.locator("article").filter({ has: memberBrowser.page.getByRole("heading", { name: "Finalize role description — manager reviewed" }) });
  await card.getByRole("button", { name: "Mark done" }).click();
  await memberBrowser.page.getByRole("heading", { name: "Finalize role description — manager reviewed" }).waitFor({ state: "detached" });
  await ownerBrowser.page.reload();
  await ownerBrowser.page.getByText(`1 of ${linkedWork.length} done`).waitFor();
  results.push("MEMBER_MY_DAY_DONE_DETERMINISTIC_PROGRESS=PASS");

  await ownerBrowser.page.goto(`${origin}/activity`);
  await ownerBrowser.page.getByText(/Goal activated and Work Items created|A goal became active/).first().waitFor();
  const goalEvents = await checked(await admin.from("activity_events").select("event_type,goal_id")
    .eq("goal_id", goalId), "goal Activity");
  assert.ok(goalEvents.some((event) => event.event_type === "goal_created"));
  assert.ok(goalEvents.some((event) => event.event_type === "goal_plan_approved"));
  assert.ok(goalEvents.some((event) => event.event_type === "goal_activated"));
  results.push("ACTIVITY_TRUST_CHAIN=PASS");

  await ownerBrowser.page.goto(`${origin}/ask`);
  await ownerBrowser.page.getByRole("textbox", { name: "Ask CrazyLoops" }).fill("How are we doing on the customer support hiring goal?");
  await ownerBrowser.page.getByRole("button", { name: "Send message" }).click();
  await ownerBrowser.page.locator(`a[href="/goals/${goalId}"]`).first().waitFor({ timeout: 60_000 });
  const answer = await ownerBrowser.page.locator("article").last().innerText();
  assert.match(answer, new RegExp(`1 of ${linkedWork.length}|one of ${linkedWork.length}`, "i"));
  results.push("GROUNDED_ASK_GOAL_STATUS_WITH_SOURCE_LINK=PASS");

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 },
    storageState: await memberBrowser.context.storageState() });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${origin}/goals/${goalId}`);
  await mobilePage.getByRole("heading", { name: /Hire 3 customer support agents/ }).waitFor();
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await mobile.close();
  results.push("MOBILE_GOAL_DETAIL_NO_HORIZONTAL_OVERFLOW=PASS");

  assert.equal(ownerBrowser.errors.length + memberBrowser.errors.length + outsiderBrowser.errors.length, 0);
  await secondTab.close();
  await ownerBrowser.context.close(); await memberBrowser.context.close(); await outsiderBrowser.context.close();
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
