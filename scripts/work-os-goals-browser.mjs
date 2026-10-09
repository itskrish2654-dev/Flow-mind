import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { createBrowserClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "@playwright/test";

const raw = await readFile(process.env.CRAZYLOOPS_ACCEPTANCE_ENV_FILE
  ?? new URL("../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(raw.split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
  .map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1).replace(/^['"]|['"]$/g, "")]; }));
assert.equal(new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname, "gamdxwtgccluifatcrrs.supabase.co");
const origin = process.env.PILOT_RC_ORIGIN ?? env.NEXT_PUBLIC_SITE_URL;
assert.ok(["localhost", "staging.crazy-loops.com"].includes(new URL(origin).hostname),
  "Browser acceptance may target only local or the authorized staging origin");
if (new URL(origin).hostname === "localhost")
  assert.ok(env.GROQ_API_KEY, "Real planning and Ask require the configured provider");
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } });
const browser = await chromium.launch({ headless: true });
const tables = ["workspaces", "workspace_memberships", "goals", "goal_plans", "goal_plan_items",
  "work_items", "approval_requests", "ask_threads", "ask_messages", "ask_turns",
  "action_executions", "activity_events", "knowledge_documents", "knowledge_chunks",
  "workspace_invitations", "connector_connections", "connector_connection_credentials",
  "gmail_ingestion_states", "gmail_push_receipts"];
const created = { users: [], workspaces: [], knowledgePath: null, knowledgeId: null,
  knowledgeDigest: null, knowledgeWorkspaceId: null };
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
async function addKnowledge(owner, page) {
  const content = Buffer.from("Customer support hiring procedure: the recruitment manager reviews the final role description before publishing. Interview notes must be reviewed before a written offer is sent. Written offer acceptance confirms each hire.");
  created.knowledgeDigest = createHash("sha256").update(content).digest("hex");
  created.knowledgeWorkspaceId = owner.workspaceId;
  await page.goto(`${origin}/knowledge`);
  await page.locator("#knowledge-file").setInputFiles({ name: "Customer Support Hiring SOP.txt",
    mimeType: "text/plain", buffer: content });
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await page.getByRole("status").getByText("Document indexed and ready for Ask.").waitFor({ timeout: 60_000 });
  const document = await checked(await admin.from("knowledge_documents")
    .select("id,storage_path,status,uploaded_by_user_id")
    .eq("workspace_id", owner.workspaceId)
    .eq("sha256", created.knowledgeDigest).single(), "uploaded SOP");
  assert.equal(document.status, "ready");
  assert.equal(document.uploaded_by_user_id, owner.id);
  created.knowledgeId = document.id;
  created.knowledgePath = document.storage_path;
  return document.id;
}

try {
  for (const table of tables) baseline[table] = await count(table);
  assert.equal(baseline.goals, 0, "Goals baseline must be empty");
  const owner = await createAccount();
  const member = await createAccount();
  const secondMember = await createAccount();
  const outsider = await createAccount();
  const ownerBrowser = await login(owner);
  const memberBrowser = await login(member);
  const secondMemberBrowser = await login(secondMember);
  const outsiderBrowser = await login(outsider);

  if (new URL(origin).hostname === "staging.crazy-loops.com") {
    await ownerBrowser.page.goto(`${origin}/settings/company`);
    await ownerBrowser.page.getByRole("heading", { name: "Invite teammates" }).waitFor();
    await ownerBrowser.page.getByRole("textbox", { name: "Work email" }).fill(member.email);
    await ownerBrowser.page.getByRole("button", { name: "Create invite" }).click();
    const invitationUrl = await ownerBrowser.page.getByRole("textbox", { name: "Invitation link" }).inputValue();
    assert.equal(new URL(invitationUrl).origin, origin);
    await memberBrowser.page.goto(invitationUrl);
    await memberBrowser.page.getByRole("heading", { name: /Join / }).waitFor();
    await memberBrowser.page.getByRole("button", { name: "Accept invitation" }).click();
    await memberBrowser.page.waitForURL(/\/my-day\?joined=1/);
    const membership = await checked(await admin.from("workspace_memberships")
      .select("workspace_id,role,is_default").eq("user_id", member.id)
      .eq("workspace_id", owner.workspaceId).single(), "accepted membership");
    assert.equal(membership.role, "member");
    assert.equal(membership.is_default, true);
    member.workspaceId = owner.workspaceId;
    await ownerBrowser.page.goto(`${origin}/settings/company`);
    await ownerBrowser.page.getByRole("textbox", { name: "Work email" }).fill(secondMember.email);
    await ownerBrowser.page.getByRole("button", { name: "Create invite" }).click();
    const secondInvitationUrl = await ownerBrowser.page.getByRole("textbox", { name: "Invitation link" }).inputValue();
    assert.equal(new URL(secondInvitationUrl).origin, origin);
    await secondMemberBrowser.page.goto(secondInvitationUrl);
    await secondMemberBrowser.page.getByRole("button", { name: "Accept invitation" }).click();
    await secondMemberBrowser.page.waitForURL(/\/my-day\?joined=1/);
    const secondMembership = await checked(await admin.from("workspace_memberships")
      .select("workspace_id,role,is_default").eq("user_id", secondMember.id)
      .eq("workspace_id", owner.workspaceId).single(), "second member acceptance");
    assert.equal(secondMembership.role, "member");
    assert.equal(secondMembership.is_default, true);
    secondMember.workspaceId = owner.workspaceId;
    results.push("BROWSER_INVITE_ACCEPTANCE_REAL_MEMBERSHIP=PASS");
  } else {
    await joinAccount(member, owner.workspaceId, "member");
    await joinAccount(secondMember, owner.workspaceId, "member");
  }

  const knowledgeId = await addKnowledge(owner, ownerBrowser.page);
  await memberBrowser.page.goto(`${origin}/knowledge`);
  await memberBrowser.page.getByRole("heading", { name: "Customer Support Hiring SOP" }).waitFor();
  assert.equal(await memberBrowser.page.locator("#knowledge-file").count(), 0);
  results.push("OWNER_KNOWLEDGE_UPLOAD_MEMBER_READ_NO_MEMBER_MANAGE=PASS");

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
  assert.ok(initialItems.length >= 2 && initialItems.length <= 12,
    "the reviewed company plan must have work for both disposable employees");
  assert.ok(initialItems.every((item) => item.assignee_user_id === null));
  assert.equal((await checked(await admin.from("work_items").select("id").eq("goal_id", goalId), "preapproval work")).length, 0);
  results.push("REAL_AI_STRUCTURED_KNOWLEDGE_GROUNDED_UNASSIGNED_PROPOSAL=PASS");

  await ownerBrowser.page.getByRole("button", { name: "Revise plan" }).click();
  const editor = ownerBrowser.page.locator('form').filter({ has: ownerBrowser.page.getByRole("button", { name: "Save proposal" }) });
  const titles = editor.getByRole("textbox", { name: "Work Item title" });
  await titles.first().fill("Finalize role description — manager reviewed");
  const assignees = editor.getByRole("combobox", { name: "Assignee" });
  for (let index = 0; index < await assignees.count(); index++)
    await assignees.nth(index).selectOption(index === 0 ? member.id : index === 1 ? secondMember.id : owner.id);
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
    .select("id,title,goal_plan_item_id,assignee_user_id,status")
    .eq("goal_id", goalId), "activated Work Items");
  assert.equal(linkedWork.length, initialItems.length);
  assert.equal(new Set(linkedWork.map((item) => item.goal_plan_item_id)).size, linkedWork.length);
  const firstEmployeeWork = linkedWork.find((item) => item.assignee_user_id === member.id);
  const secondEmployeeWork = linkedWork.find((item) => item.assignee_user_id === secondMember.id);
  assert.ok(firstEmployeeWork && secondEmployeeWork, "each employee receives approved work");
  assert.equal((await checked(await admin.from("action_executions").select("id")
    .eq("workspace_id", owner.workspaceId), "external actions")).length, 0);
  results.push("EXACT_APPROVAL_TWO_TAB_ONE_ACTIVATION_NO_EXTERNAL_ACTION=PASS");

  await secondMemberBrowser.page.goto(`${origin}/my-day`);
  await secondMemberBrowser.page.locator(`#work-item-${secondEmployeeWork.id}`).waitFor();
  assert.equal(await secondMemberBrowser.page.locator(`#work-item-${firstEmployeeWork.id}`).count(), 0);
  await memberBrowser.page.goto(`${origin}/my-day`);
  await memberBrowser.page.locator(`#work-item-${firstEmployeeWork.id}`).waitFor();
  assert.equal(await memberBrowser.page.locator(`#work-item-${secondEmployeeWork.id}`).count(), 0);
  const memberCrossRead = await dataApi(memberBrowser, `work_items?id=eq.${secondEmployeeWork.id}&select=id`);
  assert.equal(memberCrossRead.status, 200);
  assert.deepEqual(await memberCrossRead.json(), []);
  const managerDenied = await secondMemberBrowser.page.goto(`${origin}/manager`);
  assert.equal(managerDenied.status(), 404, "employees cannot open the manager cockpit");
  results.push("TWO_EMPLOYEES_MY_DAY_ASSIGNMENT_AND_MANAGER_BOUNDARY=PASS");

  await secondMemberBrowser.page.goto(`${origin}/my-day`);
  const secondCard = secondMemberBrowser.page.locator(`#work-item-${secondEmployeeWork.id}`);
  await secondCard.locator('input[name="reason"]').fill("Waiting for disposable Finance approval");
  await secondCard.getByRole("button", { name: "Blocked" }).click();
  await secondMemberBrowser.page.waitForFunction((id) =>
    document.querySelector(`#work-item-${id}`)?.textContent?.includes("Waiting for disposable Finance approval"),
    secondEmployeeWork.id, { timeout: 30_000 });
  assert.equal((await checked(await admin.from("work_items").select("status,status_reason")
    .eq("id", secondEmployeeWork.id).single(), "blocked employee work")).status, "blocked");
  await ownerBrowser.page.goto(`${origin}/manager`);
  await ownerBrowser.page.getByRole("heading", { name: "Today’s brief" }).waitFor();
  await ownerBrowser.page.getByText("Waiting for disposable Finance approval").waitFor();
  assert.equal(await memberBrowser.page.getByText("Waiting for disposable Finance approval").count(), 0);
  results.push("EMPLOYEE_BLOCKER_MANAGER_WORK_VIEW_NO_TEAMMATE_LEAK=PASS");

  await memberBrowser.page.goto(`${origin}/my-day`);
  await memberBrowser.page.getByRole("heading", { name: "Finalize role description — manager reviewed" }).waitFor();
  const card = memberBrowser.page.locator("article").filter({ has: memberBrowser.page.getByRole("heading", { name: "Finalize role description — manager reviewed" }) });
  await card.getByRole("button", { name: "Start work" }).click();
  await card.getByRole("button", { name: "Start work" }).waitFor({ state: "detached" });
  assert.equal((await checked(await admin.from("work_items").select("status")
    .eq("id", firstEmployeeWork.id).single(), "started employee work")).status, "in_progress");
  await card.getByRole("button", { name: "Mark done" }).click();
  await memberBrowser.page.locator('section[aria-labelledby="completed-title"] article')
    .filter({ has: memberBrowser.page.getByRole("heading", { name: "Finalize role description — manager reviewed" }) })
    .waitFor();
  assert.equal(await memberBrowser.page.getByRole("heading", { name: "Finalize role description — manager reviewed" }).count(), 1);
  await ownerBrowser.page.goto(`${origin}/goals/${goalId}`);
  await ownerBrowser.page.getByText(`1 of ${linkedWork.length} done`).waitFor();
  results.push("MEMBER_MY_DAY_DONE_DETERMINISTIC_PROGRESS=PASS");

  await ownerBrowser.page.goto(`${origin}/manager`);
  await ownerBrowser.page.getByText(`1 of ${linkedWork.length} Work Items done`).waitFor();
  await ownerBrowser.page.getByText("Waiting for disposable Finance approval").waitFor();
  assert.equal(await ownerBrowser.page.getByRole("heading", { level: 1, name: "Team work" }).count(), 1);
  results.push("MANAGER_BRIEF_REAL_PROGRESS_AND_BLOCKER=PASS");

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
  assert.match(answer, new RegExp(`\\b(?:1|one)\\s+of\\s+(?:the\\s+)?${linkedWork.length}\\b`, "i"));
  assert.match(answer, /linked (?:plan )?Work Items?/i);
  assert.doesNotMatch(answer, /\b(?:1|one)\s+of\s+(?:the\s+)?3\s+(?:required\s+)?hires\b/i);
  results.push("GROUNDED_ASK_GOAL_STATUS_WITH_SOURCE_LINK=PASS");

  await ownerBrowser.page.getByRole("textbox", { name: "Ask CrazyLoops" })
    .fill("What does our customer support hiring SOP require for interview notes?");
  await ownerBrowser.page.getByRole("button", { name: "Send message" }).click();
  const knowledgeSource = ownerBrowser.page.locator(`a[href^="/knowledge/${knowledgeId}?chunk="]`).first();
  await knowledgeSource.waitFor({ timeout: 60_000 });
  const knowledgeHref = await knowledgeSource.getAttribute("href");
  assert.match(knowledgeHref, /#chunk-[0-9a-f-]+$/);
  const knowledgeAnswer = await ownerBrowser.page.locator("article").last().innerText();
  assert.match(knowledgeAnswer, /review/i);
  await knowledgeSource.click();
  await ownerBrowser.page.getByRole("heading", { name: "Customer Support Hiring SOP" }).waitFor();
  assert.equal(await ownerBrowser.page.locator(`li${new URL(knowledgeHref, origin).hash}`).count(), 1);
  const outsiderKnowledge = await outsiderBrowser.page.goto(new URL(knowledgeHref, origin).toString());
  assert.equal(outsiderKnowledge.status(), 404, "another workspace must not open the cited source");
  await ownerBrowser.page.goto(`${origin}/ask`);
  results.push("GROUNDED_ASK_COMPANY_KNOWLEDGE_WITH_SOURCE_LINK=PASS");

  const previousMessages = await ownerBrowser.page.locator("article").count();
  await ownerBrowser.page.getByRole("textbox", { name: "Ask CrazyLoops" })
    .fill("What did CrazyLoops do for the hiring goal today?");
  await ownerBrowser.page.getByRole("button", { name: "Send message" }).click();
  await ownerBrowser.page.waitForFunction((before) => document.querySelectorAll("article").length >= before + 2,
    previousMessages, { timeout: 60_000 });
  const activityAnswer = await ownerBrowser.page.locator("article").last().innerText();
  assert.match(activityAnswer, /goal|activat|work item/i);
  results.push("GROUNDED_ASK_ACTIVITY_AND_GOAL_PROGRESS=PASS");

  await secondMemberBrowser.page.goto(`${origin}/ask`);
  const employeeMessagesBefore = await secondMemberBrowser.page.locator("article").count();
  await secondMemberBrowser.page.getByRole("textbox", { name: "Ask CrazyLoops" })
    .fill(`What is blocking my ${secondEmployeeWork.title} work?`);
  await secondMemberBrowser.page.getByRole("button", { name: "Send message" }).click();
  await secondMemberBrowser.page.waitForFunction((before) => document.querySelectorAll("article").length >= before + 2,
    employeeMessagesBefore, { timeout: 60_000 });
  await secondMemberBrowser.page.locator("article").last()
    .locator(`a[href="/my-day#work-item-${secondEmployeeWork.id}"]`)
    .waitFor({ timeout: 60_000 });
  assert.equal(await secondMemberBrowser.page.locator("article").last()
    .locator(`a[href="/my-day#work-item-${secondEmployeeWork.id}"]`).count(), 1);
  const employeeAnswer = await secondMemberBrowser.page.locator("article").last().innerText();
  assert.match(employeeAnswer, /blocked|waiting/i);
  assert.match(employeeAnswer, /Finance approval/i);
  const secondThreads = await checked(await admin.from("ask_threads").select("id")
    .eq("user_id", secondMember.id).eq("workspace_id", owner.workspaceId), "employee private Ask threads");
  assert.ok(secondThreads.length >= 1);
  const managerPrivateAskRead = await dataApi(ownerBrowser, `ask_threads?id=eq.${secondThreads[0].id}&select=id`);
  assert.equal(managerPrivateAskRead.status, 200);
  assert.deepEqual(await managerPrivateAskRead.json(), []);
  results.push("EMPLOYEE_ASK_GROUNDED_BLOCKER_MANAGER_PRIVATE_THREAD_DENIED=PASS");

  await ownerBrowser.page.goto(`${origin}/ask`);
  const managerMessagesBefore = await ownerBrowser.page.locator("article").count();
  await ownerBrowser.page.getByRole("textbox", { name: "Ask CrazyLoops" })
    .fill("What is blocking the team on our customer support hiring goal?");
  await ownerBrowser.page.getByRole("button", { name: "Send message" }).click();
  await ownerBrowser.page.waitForFunction((before) =>
    document.querySelectorAll("article").length >= before + 2
      || [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Retry answer")),
    managerMessagesBefore, { timeout: 60_000 });
  const retryAnswer = ownerBrowser.page.getByRole("button", { name: "Retry answer" });
  if (await retryAnswer.count()) {
    await retryAnswer.click();
    results.push("MANAGER_ASK_EXPLICIT_SAFE_RETRY_USED=PASS");
  }
  try {
    await ownerBrowser.page.waitForFunction((before) => document.querySelectorAll("article").length >= before + 2,
      managerMessagesBefore, { timeout: 60_000 });
  } catch {
    const turns = await checked(await admin.from("ask_turns")
      .select("state,failure_category,turn_sequence,created_at,completed_at,failed_at")
      .eq("workspace_id", owner.workspaceId).eq("user_id", owner.id)
      .eq("question", "What is blocking the team on our customer support hiring goal?")
      .order("created_at", { ascending: false }).limit(1), "manager Ask diagnostic");
    const browserState = await ownerBrowser.page.evaluate(() => ({
      articleCount: document.querySelectorAll("article").length,
      status: [...document.querySelectorAll('[role="status"], [role="alert"]')]
        .map((element) => element.textContent?.trim().slice(0, 180)).filter(Boolean),
    }));
    throw new Error(`Manager Ask did not render: ${JSON.stringify({ turns, browserState })}`);
  }
  const managerSources = ownerBrowser.page.locator("article").last()
    .locator(`a[href="/goals/${goalId}"]`);
  await managerSources.filter({ hasText: "Work Item" }).first().waitFor({ timeout: 60_000 });
  assert.ok(await managerSources.count() >= 1, "manager answer must cite the approved goal work");
  const managerAnswer = await ownerBrowser.page.locator("article").last().innerText();
  assert.match(managerAnswer, /blocked|waiting/i);
  assert.match(managerAnswer, /Finance approval/i);
  results.push("MANAGER_ASK_GROUNDED_TEAM_BLOCKER=PASS");

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 },
    storageState: await secondMemberBrowser.context.storageState() });
  const mobilePage = await mobile.newPage();
  for (const path of [`/goals/${goalId}`, "/my-day", "/ask", "/activity", "/knowledge"]) {
    await mobilePage.goto(`${origin}${path}`);
    await mobilePage.locator("main").first().waitFor();
    assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false,
      `mobile horizontal overflow: ${path}`);
  }
  await mobilePage.goto(`${origin}/my-day`);
  await mobilePage.locator(`#work-item-${secondEmployeeWork.id}`).waitFor();
  assert.equal(await mobilePage.locator(`#work-item-${firstEmployeeWork.id}`).count(), 0);
  await mobile.close();
  results.push("MOBILE_WORK_OS_CORE_PATHS_NO_HORIZONTAL_OVERFLOW=PASS");

  assert.equal(ownerBrowser.errors.length + memberBrowser.errors.length + secondMemberBrowser.errors.length
    + outsiderBrowser.errors.length, 0);
  await secondTab.close();
  await ownerBrowser.context.close(); await memberBrowser.context.close();
  await secondMemberBrowser.context.close(); await outsiderBrowser.context.close();
  console.log(results.join("\n"));
} finally {
  if (created.knowledgeDigest && !created.knowledgeId) {
    const { data, error } = await admin.from("knowledge_documents").select("id,storage_path")
      .eq("workspace_id", created.knowledgeWorkspaceId).eq("sha256", created.knowledgeDigest).maybeSingle();
    if (error) cleanupPassed = false;
    if (data) { created.knowledgeId = data.id; created.knowledgePath = data.storage_path; }
  }
  if (created.knowledgeId) {
    const { error } = await admin.from("knowledge_documents").delete().eq("id", created.knowledgeId);
    if (error) cleanupPassed = false;
  }
  if (created.knowledgePath) {
    const { error } = await admin.storage.from("company_knowledge").remove([created.knowledgePath]);
    if (error) cleanupPassed = false;
    const { data, error: listError } = await admin.storage.from("company_knowledge")
      .list(created.knowledgePath.slice(0, created.knowledgePath.lastIndexOf("/")));
    if (listError || data?.some((item) => item.name === created.knowledgePath.split("/").at(-1))) cleanupPassed = false;
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
