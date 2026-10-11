import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

const ACCEPTANCE_REF = "gamdxwtgccluifatcrrs";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing acceptance configuration: ${name}`);
  return value;
}

test("Ask, Activity, mobile and dismissal reflect the accepted automation", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  if (process.env.AUTOMATE_THIS_TRUST_ACCEPTANCE_ENABLED !== "true"
    || baseURL !== "https://staging.crazy-loops.com") throw new Error("Staging trust acceptance is not explicitly enabled.");
  const url = required("NEXT_PUBLIC_SUPABASE_URL");
  if (new URL(url).hostname !== `${ACCEPTANCE_REF}.supabase.co`) throw new Error("Wrong database target.");
  const admin = createClient(url, required("SUPABASE_SECRET_KEY"), { auth: { persistSession: false } });
  const publicClient = createClient(url, required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const marker = required("AUTOMATE_THIS_GMAIL_RESUME_MARKER");
  if (!/^[0-9a-f]{12}$/.test(marker)) throw new Error("Invalid acceptance marker.");
  const title = `Follow up on disposable acceptance request ${marker}`;
  const suggestions = await admin.from("automation_suggestions")
    .select("id,status,pattern_kind,owner_user_id,workspace_id,evidence_count")
    .eq("source_title", title);
  if (suggestions.error || suggestions.data.length !== 2) throw new Error("Exact acceptance suggestions are unavailable.");
  const gmail = suggestions.data.find((item) => item.pattern_kind === "gmail_follow_up");
  const ai = suggestions.data.find((item) => item.pattern_kind === "work_item_ai_result");
  if (!gmail || gmail.status !== "disabled" || gmail.evidence_count !== 3
    || !ai || !["suggested", "dismissed"].includes(ai.status)
    || ai.owner_user_id !== gmail.owner_user_id || ai.workspace_id !== gmail.workspace_id) {
    throw new Error("Acceptance suggestion identities or states are inconsistent.");
  }
  const account = await admin.auth.admin.getUserById(gmail.owner_user_id);
  if (account.error || !account.data.user?.email) throw new Error("Acceptance owner is unavailable.");
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: account.data.user.email });
  if (link.error || !link.data.properties?.hashed_token) throw new Error("Issued acceptance login could not be created.");
  const verified = await publicClient.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "magiclink" });
  if (verified.error || !verified.data.session) throw new Error("Issued acceptance login could not be verified.");
  const context = await browser.newContext({ viewport: { width: 1365, height: 850 } });
  try {
    await context.addCookies([{ name: `sb-${ACCEPTANCE_REF}-auth-token`,
      value: `base64-${Buffer.from(JSON.stringify(verified.data.session)).toString("base64url")}`,
      domain: "staging.crazy-loops.com", path: "/", httpOnly: true, secure: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    await page.goto("/ask", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Ask CrazyLoops" })).toBeVisible();
    await page.getByLabel("Ask CrazyLoops").fill("What automations has CrazyLoops found for my repeated follow-up work? Give me the source.");
    await page.getByRole("button", { name: "Send message" }).click();
    await page.waitForURL((target) => Boolean(target.searchParams.get("request")), { timeout: 15_000 });
    const requestId = new URL(page.url()).searchParams.get("request");
    if (!requestId) throw new Error("Ask request identifier was not retained.");
    await expect.poll(async () => {
      const turn = await admin.from("ask_turns").select("state")
        .eq("user_id", gmail.owner_user_id).eq("request_id", requestId).maybeSingle();
      return turn.error?.code ?? turn.data?.state ?? "missing";
    }, { timeout: 90_000 }).toBe("completed");
    const turn = await admin.from("ask_turns").select("id,thread_id")
      .eq("user_id", gmail.owner_user_id).eq("request_id", requestId).single();
    if (turn.error || !turn.data) throw new Error("Completed Ask turn was not persisted.");
    const answer = await admin.from("ask_messages").select("response_metadata,content")
      .eq("turn_id", turn.data.id).eq("user_id", gmail.owner_user_id)
      .eq("role", "assistant").single();
    if (answer.error || !answer.data) throw new Error("Grounded Ask answer was not persisted.");
    const metadata = answer.data.response_metadata;
    const references = typeof metadata === "object" && metadata && !Array.isArray(metadata)
      && "references" in metadata && Array.isArray(metadata.references) ? metadata.references : [];
    if (!references.some((reference: unknown) => typeof reference === "object" && reference
      && "entityId" in reference && reference.entityId === gmail.id
      && "kind" in reference && reference.kind === "automation")) {
      throw new Error("Ask did not cite the exact owner-visible Gmail automation.");
    }
    if (/I (?:activated|sent) (?:the|your) automation/i.test(answer.data.content)) {
      throw new Error("Ask falsely claimed it changed or sent the automation.");
    }
    await page.goto(`/ask?thread=${turn.data.thread_id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("link", { name: title }).first()).toHaveAttribute("href", `/automations/${gmail.id}`);
    const activity = await admin.from("activity_events").select("event_type")
      .eq("workspace_id", gmail.workspace_id).eq("owner_user_id", gmail.owner_user_id)
      .eq("source_id", gmail.id);
    const kinds = new Set(activity.data?.map((event) => event.event_type));
    if (activity.error || !["automation_suggested", "automation_activated", "automation_triggered", "automation_disabled"]
      .every((kind) => kinds.has(kind))) throw new Error("Durable automation Activity is incomplete.");
    await page.goto("/activity", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Activity", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/automations", { waitUntil: "domcontentloaded" });
    const disabled = page.getByRole("article").filter({ hasText: title }).filter({ hasText: "Gmail follow-up" });
    await expect(disabled).toHaveCount(1);
    await expect(disabled.getByRole("link", { name: "Review automation" })).toBeVisible();
    const aiCard = page.getByRole("article").filter({ hasText: title }).filter({ hasText: "AI preparation" });
    if (ai.status === "suggested") {
      await expect(aiCard.getByRole("button", { name: "Not now" })).toBeVisible();
      await aiCard.getByRole("button", { name: "Not now" }).click();
      await expect.poll(async () => {
        const current = await admin.from("automation_suggestions").select("status").eq("id", ai.id).single();
        return current.error?.code ?? current.data?.status ?? "missing";
      }, { timeout: 30_000 }).toBe("dismissed");
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("article").filter({ hasText: title }).filter({ hasText: "AI preparation" })).toHaveCount(0);
    const stillOne = await admin.from("automation_suggestions").select("id", { count: "exact", head: true })
      .eq("workspace_id", gmail.workspace_id).eq("owner_user_id", gmail.owner_user_id)
      .eq("pattern_kind", "work_item_ai_result").eq("source_title", title);
    if (stillOne.error || stillOne.count !== 1) throw new Error("Dismissal allowed a duplicate suggestion.");
  } finally {
    await context.close();
  }
});
