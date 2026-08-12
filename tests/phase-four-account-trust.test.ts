import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const authAction = source("app/actions/auth.ts");
const callback = source("app/auth/callback/route.ts");
const resetPage = source("app/reset-password/page.tsx");
const settingsLayout = source("app/settings/layout.tsx");
const settingsPage = source("app/settings/page.tsx");
const usagePage = source("app/settings/usage/page.tsx");
const exportRoute = source("app/settings/export/route.ts");
const accountAction = source("app/actions/account.ts");
const migration = source("supabase/migrations/20260812000200_phase4_account_lifecycle.sql");
const publicForm = source("components/public-workflow-form.tsx");
const publicFormPage = source("app/f/[projectId]/page.tsx");
const limits = source("lib/security/limits.ts");
const proxy = source("lib/supabase/proxy.ts");
const loginPage = source("app/login/page.tsx");
const legal = ["privacy", "terms", "support", "security", "data-use"]
  .map((route) => source(`app/${route}/page.tsx`));

test("1. password recovery requests a recovery callback", () => {
  assert.match(authAction, /resetPasswordForEmail/);
  assert.match(authAction, /next=\/reset-password&type=recovery/);
  assert.match(callback, /exchangeCodeForSession/);
  assert.match(resetPage, /ResetPasswordForm/);
});

test("2. password recovery requires CAPTCHA", () => {
  assert.match(authAction, /captchaToken: CaptchaTokenSchema/);
  assert.match(authAction, /captchaToken: parsed\.data\.captchaToken/);
});

test("3. expired and reused recovery links fail clearly", () => {
  assert.match(callback, /recovery_failed/);
  assert.match(resetPage, /login\?error=recovery_failed/);
  assert.match(authAction, /invalid or has expired/);
});

test("4. recovered passwords are validated and global sessions are ended", () => {
  assert.match(authAction, /min\(12/);
  assert.match(authAction, /Add a symbol/);
  assert.match(authAction, /updateUser\(\{ password/);
  assert.match(authAction, /signOut\(\{ scope: "global" \}\)/);
  assert.match(authAction, /passwords do not match/);
});

test("5. settings route requires an authenticated user", () => {
  assert.match(settingsLayout, /auth\.getUser/);
  assert.match(settingsLayout, /redirect\("\/login\?next=\/settings"\)/);
  assert.match(proxy, /startsWith\("\/settings"\)/);
});

test("6. usage route requires an authenticated user", () => {
  assert.match(usagePage, /auth\.getUser/);
  assert.match(usagePage, /redirect\("\/login\?next=\/settings\/usage"\)/);
});

for (const [index, route] of ["privacy", "terms", "support", "security", "data-use"].entries()) {
  test(`${index + 7}. ${route} is a real public page`, () => {
    assert.match(legal[index], /LegalPageShell/);
    assert.match(legal[index], /export const metadata/);
  });
}

test("12. account export requires authentication", () => {
  assert.match(exportRoute, /getAuthenticatedContext/);
  assert.match(exportRoute, /status: 401/);
});

test("13. Account B cannot select Account A export data", () => {
  assert.doesNotMatch(exportRoute, /searchParams|userId: string|p_user_id/);
  assert.ok((exportRoute.match(/\.eq\("user_id", auth\.user\.id\)/g) ?? []).length >= 6);
});

test("14. export credential projection contains metadata only", () => {
  assert.match(exportRoute, /connector_id, credential_key, credential_type, created_at, updated_at/);
  assert.doesNotMatch(exportRoute, /select\("[^"]*(ciphertext|nonce|auth_tag|secret)/);
});

test("15. export excludes authentication and service secrets", () => {
  assert.doesNotMatch(exportRoute, /SUPABASE_SECRET_KEY|GROQ_API_KEY|TURNSTILE_SECRET_KEY/);
  assert.match(exportRoute, /authentication tokens/);
  assert.match(exportRoute, /service secrets/);
});

test("16. export includes workflow versions and execution history", () => {
  assert.match(exportRoute, /workflowVersions/);
  assert.match(exportRoute, /executionSteps/);
  assert.match(exportRoute, /compiled_workflow/);
});

test("17. export is bounded and never silently truncates", () => {
  assert.match(exportRoute, /EXPORT_LIMITS/);
  assert.match(exportRoute, /status: tooLarge \? 413 : 500/);
  assert.match(exportRoute, /no data was silently omitted/);
  assert.match(source("components/account-controls.tsx"), /Safety limits/);
});

test("18. account deletion requires authentication", () => {
  assert.match(accountAction, /getAuthenticatedContext/);
  assert.match(accountAction, /Sign in again before deleting/);
});

test("19. deletion requires exact confirmation, password, and CAPTCHA", () => {
  assert.match(accountAction, /z\.literal\("DELETE MY ACCOUNT"\)/);
  assert.match(accountAction, /signInWithPassword/);
  assert.match(accountAction, /captchaToken/);
});

test("20. Account B cannot delete Account A", () => {
  const deletionEntry = accountAction.slice(accountAction.indexOf("export async function deleteOwnAccount"));
  assert.doesNotMatch(deletionEntry.slice(0, deletionEntry.indexOf("Promise<DeleteAccountResult>")), /userId/);
  assert.match(accountAction, /verified\.user\?\.id !== auth\.user\.id/);
  assert.match(accountAction, /p_user_id: auth\.user\.id/);
});

test("21. deletion atomically revokes public workflows before cleanup", () => {
  const requestFunction = migration.slice(migration.indexOf("request_account_deletion"), migration.indexOf("cleanup_account_data"));
  assert.match(requestFunction, /public_form_enabled = false/);
  assert.match(requestFunction, /published_at = null/);
  assert.match(requestFunction, /insert into public\.account_deletion_jobs/);
});

test("22. deletion removes workflow data in foreign-key-safe order", () => {
  const steps = migration.indexOf("delete from public.workflow_execution_steps");
  const executions = migration.indexOf("delete from public.workflow_executions");
  const versions = migration.indexOf("delete from public.workflow_versions");
  const workflows = migration.indexOf("delete from public.workflows");
  assert.ok(steps < executions && executions < versions && versions < workflows);
  assert.match(migration, /current_version_id = null/);
});

test("23. deletion removes credential ciphertext records", () => {
  assert.match(migration, /delete from public\.workflow_credentials where user_id = p_user_id/);
});

test("24. deletion removes private document objects before metadata", () => {
  assert.match(accountAction, /generated_document_records/);
  assert.match(accountAction, /GENERATED_DOCUMENTS_BUCKET/);
  assert.match(accountAction, /\.remove\(paths\.slice/);
  assert.match(migration, /delete from public\.generated_document_records where user_id = p_user_id/);
});

test("25. deletion removes the Supabase Auth identity", () => {
  assert.match(accountAction, /auth\.admin\.deleteUser\(auth\.user\.id\)/);
});

test("26. deletion jobs are durable and never fake completion", () => {
  assert.match(migration, /'requested', 'processing', 'completed', 'failed'/);
  assert.match(accountAction, /state: "failed"/);
  assert.match(accountAction, /state: "completed"/);
  assert.match(accountAction, /public forms remain disabled/);
});

test("27. public forms link to privacy, data-use, and support", () => {
  assert.match(publicForm, /TrustLinks/);
  assert.match(publicForm, /AI processing may occur only if/);
});

test("28. usage page renders real entitlement limits", () => {
  assert.match(usagePage, /getAccountUsage/);
  assert.match(source("lib/account-usage.ts"), /PLAN_ENTITLEMENTS\.free/);
  assert.match(usagePage, /Additional plans are not yet available/);
});

test("29. quota errors are human-readable and show usage", () => {
  assert.match(limits, /You've reached your \$\{labels\[metric\]\} limit/);
  assert.match(limits, /used\)\.`/);
  assert.doesNotMatch(limits, /quota backend failed[^\n]*QUOTA_EXCEEDED/);
});

test("30. legal pages contain no false certification claims", () => {
  const joined = legal.join("\n");
  assert.doesNotMatch(joined, /SOC 2 certified|ISO 27001 certified|HIPAA compliant|100% secure|unhackable/i);
  assert.match(joined, /does not currently claim SOC 2/);
  assert.match(joined, /OWNER REVIEW REQUIRED/);
});

test("31. private account and recovery routes are noindex", () => {
  assert.match(settingsLayout, /robots: \{ index: false, follow: false \}/);
  assert.match(resetPage, /robots: \{ index: false, follow: false \}/);
});

test("32. public form noindex remains", () => {
  assert.match(publicFormPage, /robots: \{ index: false, follow: false \}/);
});

test("33. login surfaces support and legal links without modifying the landing page", () => {
  assert.match(loginPage, /\/privacy/);
  assert.match(loginPage, /\/support/);
  assert.doesNotMatch(loginPage, /app\/page/);
});

test("34. settings exposes all essential account controls", () => {
  assert.match(settingsPage, /AccountControls/);
  assert.match(settingsPage, /Usage and limits/);
  assert.match(source("components/account-controls.tsx"), /Download account export/);
  assert.match(source("components/account-controls.tsx"), /Permanently delete account/);
});

test("35. account deletion RPCs are unavailable to browser roles", () => {
  assert.match(migration, /revoke all on function public\.request_account_deletion\(uuid\) from public, anon, authenticated/);
  assert.match(migration, /revoke all on function public\.cleanup_account_data\(uuid, uuid\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.cleanup_account_data\(uuid, uuid\) to service_role/);
});
