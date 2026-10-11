# CrazyLoops — first customer pilot release candidate v1

This is a release record, not authorization to deploy customer production. The release branch is `codex/work-os-first-customer-rc-v1`. It descends from the accepted Pilot Readiness commit `fb36771fd54b9b2817c612be6b018bc43b2132da` without changing product behavior. The RC updates vulnerable production dependencies to patched versions; obtain its exact release commit with `git rev-parse HEAD` on that branch. Do not merge or modify frozen `main` for this pilot gate.

## Customer surface

The normal first-company route is signup → Getting started → workspace name → invitation links and roles → Company Knowledge → Goal and reviewed AI plan → assigned Work Items → My Day and Do with AI → final work and manager progress. Ask, Activity, approvals, Automate This, and the existing workflow builder remain available under their established ownership and capability gates. Managers can see appropriate final work and progress, not private Ask conversations or private Workbench drafts.

Gmail, Slack, and Google Calendar have accepted provider-backed paths in this lineage. Google Sheets write acceptance and Notion connection/action acceptance are restricted to the separate staging acceptance origin and Supabase project; their general customer-production capability flags remain off. Notion workflows are not pilot-ready. Internal test connectors, runner canaries, and unsupported operations must not be represented as customer-ready merely because their code exists.

## Deployment dependencies and preflight

- Deploy only an explicitly approved release SHA to a customer environment separate from `crazyloops-staging`. Staging uses `https://staging.crazy-loops.com` and acceptance Supabase ref `gamdxwtgccluifatcrrs`; do not reuse those credentials, provider apps, or data for a customer.
- Apply and verify the 53 ordered, transaction-bounded migrations in `supabase/migrations`, ending with `20261010000000_work_os_automate_this_v1.sql`, through the established migration pipeline. Take a database backup and record the pre-migration version/counts. Do not use ad hoc schema changes. The current checkout's Supabase CLI link is **not** the authorized acceptance project; verify the exact target ref before any linked CLI command.
- Configure the required runtime names from `.env.example`: modern Supabase public URL/publishable key and server secret key, canonical site URL, Groq key, credential master key, rate-limit secret, cron and schedule-dispatch secrets as applicable, support address, and provider-specific OAuth/webhook secrets for integrations actually offered. `NEXT_PUBLIC_*` values are browser-visible; all other credentials remain server-only. Disable delegated runner paths unless separately accepted for that target.
- Configure the customer origin and exact Google/Slack/Notion OAuth callbacks and webhook URLs in the corresponding customer-only provider apps before exposing those connectors. Verify minimal scopes and signed inbound events. Staging provider credentials and callbacks are not a customer configuration.
- Configure a real CAPTCHA site/secret and fail-closed auth mode for customer signup, sign-in, and recovery. The staging pilot journey used the acceptance-only disabled CAPTCHA mode. Check Supabase Auth leaked-password protection, email templates, redirect allowlist, and actual confirmation/recovery delivery.
- Company invitations are generated and copied from the admin UI as one-time links; the product does **not** email those invitations itself. Agree on an approved channel for the owner to deliver them securely.
- Verify the private `company_knowledge` Storage bucket, database RLS/advisors, service-only maintenance permissions, cron ownership, rate limits, secret isolation, and alert recipient. `/api/health` must return HTTP 200 with `status=ok` and `database=ok`; review bounded runtime logs for unexplained errors.

## Validation and rollback

Pilot Readiness passed 1,216 deterministic tests, TypeScript, ESLint, migration/environment validation, production build, anonymous RLS checks, and a fresh three-person staging browser journey. The disposable owner, two employees, their workspaces, Goal, Work Items, and Knowledge document were removed after acceptance. Desktop manager and mobile employee screens were checked. The patched RC must pass these deterministic gates again and a fresh staging smoke; prior browser evidence alone is not a claim that the patched build was exercised. These staging results do not replace a final smoke on the exact customer deployment.

The prior staging deployment `dpl_DCe6ThR5zasyYYfMNcbYfZGwigEs` is a functional comparison checkpoint, **not a safe security rollback**: it uses a vulnerable Next.js dependency. Keep the patched RC staging deployment as the next rollback checkpoint only after its health and smoke gates pass. For a first customer deployment there may be no previous safe build; withdraw pilot traffic and pause invitations/external actions if it fails, then use a tested forward correction. **Do not** reverse a committed migration blindly. A restored backup requires a separately approved incident plan.

## Known pilot limits

- The RC pins Next.js 16.3.8 and locks patched Sharp 0.35.5, source-map-js 1.2.2, and Undici 7.30.0. The production dependency audit has zero findings. Seven high-severity development-tooling audit findings remain in the lint dependency tree; this is not a claim that the full development dependency audit is clean.
- Sheets writes and Notion actions/workflows are not generally product-enabled for a customer pilot despite isolated staging acceptance; keep their gates in place until separately released.
- The Notion picker can show a provider data source whose parent label is still unfamiliar to its owner. Confirm the exact shared resource before any Notion write.
- Automate This needs repeated qualifying work; one completed task correctly produces no suggestion.
- An active Goal plan is not automatically reassigned when a member leaves; its missing linked Work Item is surfaced for manager review.
- Company invitations require manual secure delivery of the one-time link. Billing can remain manual for the first pilot.
- Long-term company-wide approval/audit retention and formal legal review remain owner decisions before broader rollout.

Before inviting a real company, repeat authenticated owner/employee desktop and mobile smoke, cross-workspace and private-content checks, one safe accepted connector read/action, `/api/health`, bounded logs, and rollback identification against the exact customer release. Do not infer readiness from a Vercel “Ready” status alone.
