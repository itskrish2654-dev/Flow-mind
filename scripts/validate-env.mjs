import { readFile } from "node:fs/promises";

const file = process.argv[2] || ".env.example";
const text = await readFile(file, "utf8");
const names = new Set(
  text.split(/\r?\n/)
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
    .map((line) => line.split("=", 1)[0]),
);
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
  "GOOGLE_PUBSUB_AUDIENCE",
  "GOOGLE_PUBSUB_SERVICE_ACCOUNT",
  "GOOGLE_GMAIL_PUBSUB_TOPIC",
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
];
for (const name of required) if (!names.has(name)) throw new Error(`Missing environment inventory item: ${name}`);
for (const obsolete of ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (names.has(obsolete)) throw new Error(`Obsolete environment variable remains: ${obsolete}`);
}
console.log(`Validated ${names.size} documented environment variable names; no legacy key names remain.`);
