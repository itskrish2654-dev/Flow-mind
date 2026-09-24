import { readFile } from "node:fs/promises";

const file = process.argv[2] || ".env.example";
const text = await readFile(file, "utf8");
const assignments = text.split(/\r?\n/)
  .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line))
  .filter(Boolean)
  .map((match) => [match[1], match[2]]);
const values = new Map(assignments);
const names = new Set(values.keys());
const required = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "GROQ_API_KEY",
  "NEXT_PUBLIC_SITE_URL",
  "FLOWMIND_CREDENTIAL_MASTER_KEY",
  "FLOWMIND_RATE_LIMIT_SECRET",
  "FLOWMIND_CONNECTOR_ENDPOINT_SECRET",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_PICKER_API_KEY",
  "GOOGLE_PICKER_APP_ID",
  "GOOGLE_PUBSUB_AUDIENCE",
  "GOOGLE_PUBSUB_SERVICE_ACCOUNT",
  "GOOGLE_GMAIL_PUBSUB_TOPIC",
  "PHASE6B1D_GMAIL_ACCEPTANCE_ENABLED",
  "PHASE6B1D_GMAIL_ACCEPTANCE_OPERATOR_SECRET",
  "PHASE6B1D_GMAIL_ACCEPTANCE_OWNER_ID",
  "PHASE6B1D_GMAIL_ACCEPTANCE_ACCOUNT_EMAIL",
  "PHASE6B1D_GMAIL_ACCEPTANCE_RECIPIENT_EMAIL",
  "PHASE6B1D_GMAIL_ACCEPTANCE_RUN_ID",
  "FLOWMIND_CONNECTOR_SLACK_CLIENT_ID",
  "FLOWMIND_CONNECTOR_SLACK_CLIENT_SECRET",
  "FLOWMIND_CONNECTOR_SLACK_SIGNING_SECRET",
  "FLOWMIND_CONNECTOR_NOTION_CLIENT_ID",
  "FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET",
  "FLOWMIND_CONNECTOR_NOTION_WEBHOOK_VERIFICATION_TOKEN",
  "FLOWMIND_CONNECTOR_NOTION_SETUP_SECRET",
  "NEXT_PUBLIC_TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
  "CRON_SECRET",
  "SCHEDULE_DISPATCH_SECRET",
];
for (const name of required) if (!names.has(name)) throw new Error(`Missing environment inventory item: ${name}`);
for (const obsolete of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (names.has(obsolete)) throw new Error(`Obsolete environment variable remains: ${obsolete}`);
}

const gmailAcceptanceEnabled = values.get("PHASE6B1D_GMAIL_ACCEPTANCE_ENABLED") ?? "";
if (!["", "false", "true"].includes(gmailAcceptanceEnabled)) {
  throw new Error("PHASE6B1D_GMAIL_ACCEPTANCE_ENABLED must be exactly true, false, or empty.");
}
for (const name of names) {
  if (name.startsWith("NEXT_PUBLIC_PHASE6B1D_GMAIL_ACCEPTANCE_")) {
    throw new Error(`Acceptance configuration must remain server-only: ${name}`);
  }
}

if (gmailAcceptanceEnabled === "true") {
  const operatorSecret = values.get("PHASE6B1D_GMAIL_ACCEPTANCE_OPERATOR_SECRET") ?? "";
  const ownerId = values.get("PHASE6B1D_GMAIL_ACCEPTANCE_OWNER_ID") ?? "";
  const runId = values.get("PHASE6B1D_GMAIL_ACCEPTANCE_RUN_ID") ?? "";
  const accountEmail = (values.get("PHASE6B1D_GMAIL_ACCEPTANCE_ACCOUNT_EMAIL") ?? "").trim().toLowerCase();
  const recipientEmail = (values.get("PHASE6B1D_GMAIL_ACCEPTANCE_RECIPIENT_EMAIL") ?? "").trim().toLowerCase();
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  if (operatorSecret.length < 32 || /\s/.test(operatorSecret)) {
    throw new Error("Phase 6B.1D operator secret is missing or invalid.");
  }
  if (!uuidPattern.test(ownerId) || !uuidPattern.test(runId)) {
    throw new Error("Phase 6B.1D owner or run identifier is missing or invalid.");
  }
  if (!emailPattern.test(accountEmail) || !emailPattern.test(recipientEmail) || accountEmail === recipientEmail) {
    throw new Error("Phase 6B.1D mailbox configuration is missing or invalid.");
  }
  const forbiddenSecretNames = [
    "CRON_SECRET",
    "SCHEDULE_DISPATCH_SECRET",
    "CONNECTOR_RUNNER_SECRET",
    "FLOWMIND_CREDENTIAL_MASTER_KEY",
    "FLOWMIND_RATE_LIMIT_SECRET",
    "SUPABASE_SECRET_KEY",
    "TURNSTILE_SECRET_KEY",
    "GOOGLE_OAUTH_CLIENT_SECRET",
  ];
  if (forbiddenSecretNames.some((name) => values.get(name) && values.get(name) === operatorSecret)) {
    throw new Error("Phase 6B.1D operator secret must be dedicated.");
  }
}
console.log(`Validated ${names.size} documented environment variable names; no legacy key names remain.`);
