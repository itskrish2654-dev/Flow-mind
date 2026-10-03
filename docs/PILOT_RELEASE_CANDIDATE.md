# CrazyLoops Work OS — Pilot Release Candidate v1

This document describes the pilot scope, not a customer-production deployment. The pilot release is staged at `https://staging.crazy-loops.com` in the separate `crazyloops-staging` Vercel project and uses only the authorized acceptance Supabase project. The customer `flow-mind` project and frozen `main` branch are outside this release.

## Pilot-ready

- Company workspaces with owner, admin, and member roles, invitations, and workspace switching.
- My Day with durable Work Items and approval requests.
- Ask CrazyLoops for grounded, cited answers from authorized work and Company Knowledge, with exact previews and approval before supported external actions.
- Goals → grounded plan → manager review → assigned Work Items → deterministic progress and Activity history.
- Private Company Knowledge documents with workspace-scoped retrieval.
- Unified, company-safe Activity for work, approvals, actions, knowledge, and goals.
- Gmail mailbox context, incoming actionable work, and exact approved email sending. Gmail is the only externally live-accepted Work OS connector in this candidate.
- Existing first-party workflow primitives, subject to their normal publication, ownership, and quota checks.

No pilot feature should be represented as working solely because connector code, an OAuth client, or credentials exist. The capability registry and Connections screen keep unaccepted providers out of the ready path.

## Deferred

- Google Sheets: implementation and deterministic security tests are retained, but OAuth, Google Picker, selected-file access, read/append/update, acknowledgement, and isolation still need a dedicated live-provider acceptance. Its production operation and onboarding flags remain off.
- Slack: preserve the separate in-progress branch and migration work; no live-provider acceptance or pilot exposure here.
- Notion, Google Calendar, Airtable, HubSpot, and other unaccepted external providers: not pilot-ready. No fabricated provider acknowledgements.
- OCR and embeddings. Knowledge retrieval covers the supported text/PDF extraction path only.
- In-place reassignment of an active Goal plan after a member departs. The missing linked Work Item is surfaced instead of silently counting it complete.
- A company-wide long-term approval/audit retention policy, beyond current application behavior.

## Pilot setup

1. Use a dedicated pilot/staging Vercel project, domain, Supabase project, and provider credentials. Never point staging at customer production credentials or storage.
2. Apply the committed, ordered Supabase migrations to the authorized pilot database. At this candidate's starting checkpoint the history contains 49 migrations, ending with the Goals foreign-key index migration. Do not reset or roll it back.
3. Configure the environment variables documented in `.env.example` for the pilot project. At minimum validate the modern Supabase publishable/secret key pairing, canonical staging URL, Groq key for real Ask/plan generation, credential master key, rate-limit/cron secrets, and the applicable Gmail OAuth client. Keep every backend secret server-only. Do not enable delegated/Activepieces/runner paths without their separate acceptance.
4. Configure a staging-only Gmail OAuth client with the exact staging callback and a disposable pilot mailbox. Verify requested scopes and reconnect behavior. Do not reuse customer-production OAuth credentials.
5. Create the company workspace with a legitimate owner session. Invite a small employee cohort through the supported invite flow; verify each user lands in the intended workspace and role before adding company material.
6. Upload a synthetic or approved policy/SOP to private Company Knowledge. Ask a grounded question and inspect the citation before testing a Goal, plan, assignment, completion, and Activity journey.
7. Use disposable provider resources and manifest-owned fixtures for acceptance. Record baseline and final row/object counts; clean only artifacts created by the pilot test.

## Pre-production owner checklist

- Approve a separate customer-production deployment explicitly; this staging RC is not that approval.
- Verify production Vercel project, canonical domain/DNS/TLS, Supabase project, modern keys, storage bucket privacy, and environment isolation independently.
- Configure production-only Groq, Google/Gmail OAuth redirect URLs, Google consent/verification status, and required Turnstile site/secret keys. Do not paste credentials into issues or release notes.
- Enable and verify Supabase Auth leaked-password protection in the dashboard; it is a control-plane setting, not a code migration.
- Verify provider console webhook URLs and signing secrets only for integrations independently accepted for production.
- Verify cron/scheduled dispatch routes and their authentication, rate limits, quotas, and operational ownership.
- Review audit/approval retention and deletion obligations for the pilot company before storing real company data.
- Re-run authenticated desktop/mobile, cross-user/workspace, secret-exposure, health, advisor, runtime-log, and cleanup checks against the exact proposed production commit before inviting customers.

## Release gate

The RC is not accepted merely because local tests or a Vercel build pass. Acceptance requires a Ready deployment of the exact feature-branch commit to the separate staging project; healthy `/api/health`; real authenticated owner/employee browser journeys; current-source Ask and Goal behavior; privacy isolation; zero unexplained runtime errors; and manifest-owned fixture cleanup with explicit final database and Storage counts. Missing staging provider/AI configuration must be recorded as a blocker rather than simulated.
