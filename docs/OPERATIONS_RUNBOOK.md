# Production operations runbook

## Deploy and rollback

1. Merge only after CI passes: lockfile install, migrations, environment inventory, unit/regression tests, TypeScript, ESLint, production build, public E2E smoke, and secret scan.
2. Confirm required Vercel Production variables by name and scope. Never copy values into tickets or logs.
3. Apply ordered Supabase migrations with `npx supabase db push`, review the plan, then run `npx supabase db lint --linked`.
4. Deploy the same Git commit to Vercel and smoke `/api/health`, login, one disposable workflow, public form, AI, PDF, and signed document access.
5. For rollback, use Vercel's previous known-good deployment. Do not reverse a database migration destructively. Deploy a forward-compatible corrective migration when schema rollback is needed.

## Key model and rotation

- Browser: modern `sb_publishable_*` key only.
- Backend: modern `sb_secret_*` key only; it bypasses RLS and every privileged mutation must independently authorize ownership.
- Supabase/Groq/Turnstile compromise: revoke or rotate at the provider, update Vercel scopes, redeploy, and verify the retired key fails.
- Credential master key: version 1 supports one active key. Re-encrypt every credential under a new key before replacing it. Replacing it early makes stored connector credentials unavailable.
- Rate-limit secret rotation changes hashes and effectively starts new identity buckets; plan the change as a security operation.

## Turnstile

Configure the public site key in Vercel and the matching secret in Supabase Auth Bot and Abuse Protection. Configure `TURNSTILE_SECRET_KEY` for costly hosted forms. Login/signup/recovery and costly public forms fail closed when their challenge configuration is absent.

## Scheduled maintenance

Supabase Cron calls the overlap-safe database maintenance function every ten minutes. It reconciles executions stale for 15 minutes, removes rate-limit rows whose windows expired more than 24 hours ago, removes expired concurrency leases, and flags interrupted deletion jobs. A daily Vercel call to `/api/operations/maintenance`, authorized with `CRON_SECRET`, repeats the idempotent database maintenance and retries a bounded set of safe failed deletion jobs that need Auth or Storage APIs. Check `operational_maintenance_runs`, `cron.job_run_details`, `operational_events`, and Vercel runtime logs. Never expose the cron authorization value.

## Workflow schedules

Supabase Cron calls `/api/operations/schedules` every minute using the bearer value stored in Supabase Vault by `configure_schedule_dispatch`. The application must have the same value in `SCHEDULE_DISPATCH_SECRET`. Each due occurrence is claimed atomically, pinned to an immutable workflow version, and protected by a unique occurrence key. A delayed dispatcher collapses missed backlog into one current run and records the scheduled and actual start times. Disable a workflow immediately when a schedule repeatedly fails, then inspect `workflow_schedules`, `workflow_schedule_occurrences`, sanitized operational events, and Vercel logs. Rotate the dispatcher value in both Vercel and Vault together; never print it.

## Investigating failures

Use the user's short error reference to find `operational_events.id` prefix or the structured Vercel event. Correlate by execution/workflow/version/step IDs. Inspect only sanitized execution-step metadata. For repeated AI, PDF, database, credential-vault, public-form, reconciliation, or deletion failures, disable the affected path or unpublish forms before diagnosis if continued execution may cause harm.

## Emergency controls

- Disable public forms globally by revoking/setting `public_form_enabled = false` using an audited owner-scoped or emergency administrator procedure. Do not delete workflows.
- Revoke compromised credentials at their provider, update environment scopes, redeploy, and invalidate affected connector credentials.
- For suspected cross-user exposure, stop deployments and public execution, preserve logs, test A/B isolation with disposable accounts, and follow the incident runbook.
- Operational error events are emitted at `error` level for Vercel alert rules. The owner must configure the alert notification destination and thresholds before broad public launch.

## Local verification

Use Node 22+, `npm ci`, and Playwright Chromium. Ordinary unit tests use no production secrets. Authenticated E2E uses a disposable account storage state created through real CAPTCHA: set `E2E_STORAGE_STATE` to that file. Set `E2E_BASE_URL` to target an already deployed environment; otherwise Playwright starts the local server.
