# CrazyLoops

CrazyLoops is a Next.js 16 automation builder backed by Supabase Auth, Postgres Row Level Security, and Groq.

## Local setup

1. Copy `.env.example` to `.env.local`. The Supabase backend secret, Groq key,
   credential master key, rate-limit secret, and Turnstile secret are server-only.
   Generate the credential and rate-limit keys with a cryptographically secure
   random generator; never commit or print them.
2. Apply the migrations to the linked Supabase project. If this folder is not linked yet:

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

Apply every migration in timestamp order. The Phase 2 migration revokes legacy
implicitly-public form links; owners must explicitly publish those forms again.

3. Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Unauthenticated dashboard and settings requests redirect to `/login`.

## Security model

- Supabase sessions are stored in cookies through `@supabase/ssr`.
- Next.js `proxy.ts` refreshes sessions and protects every `/dashboard` and `/settings` route.
- Every Server Action independently verifies the user with `supabase.auth.getUser()`.
- Every owner query includes the authenticated `user_id`.
- Cloudflare Turnstile must be enabled in Supabase Auth Bot and Abuse Protection.
  Supabase Auth CAPTCHA is the authoritative control for direct signup, password
  sign-in, and password-recovery endpoints. CrazyLoops' Postgres auth limiter is
  additional defense in depth and does not protect requests sent directly to Supabase.
- Authenticated browser roles can read only owner-scoped workflows and executions.
  Workflow mutations and trusted execution inserts use server actions and a
  server-only service role so quotas, publication, and derived fields cannot be bypassed.
- Connector credentials use AES-256-GCM with a unique nonce, authenticated owner/
  workflow/connector context, and ciphertext version metadata. Plaintext is never
  returned after submission. Version 1 supports one active environment master key;
  rotate by decrypting and re-encrypting records before replacing that key. Automatic
  multi-key rotation is intentionally deferred. The master key format is canonical
  padded standard Base64 for exactly 32 bytes; whitespace, alternate encodings,
  malformed padding, and trailing data are rejected.
- Rate limits, monthly usage counters, and concurrency leases are stored atomically
  in Postgres and fail closed when unavailable.
- Generated PDFs use a private bucket. Owners receive signed download links that
  expire after 15 minutes. Workflow deletion removes its recorded files. Account
  deletion disables public forms first, removes recorded private objects, deletes
  owner data transactionally, and finally removes the Supabase Auth identity.
- Account export is authenticated, owner-scoped, server-generated, bounded, and
  excludes credential ciphertext, encryption material, tokens, and service secrets.
- Hosted forms are private by default and require explicit Publish / Unpublish actions.
- Publishing a public form that uses AI or PDF generation automatically enables
  Cloudflare Turnstile. The form fails closed when production Turnstile keys are
  unavailable. Lower-cost internal-storage forms retain the honeypot plus durable
  IP/workflow limits; distributed public-form abuse remains a monitored residual risk.

## Verification

```bash
npm ci
npm run check
npx playwright install chromium
npm run test:e2e
npx supabase db lint --linked
npm run lint
npm run build
npm run verify:rls
```

`verify:rls` must report zero anonymous rows or a 401/403 response before deployment.

CI runs migration and environment validation, the complete Phase 1–6 regression
suite, TypeScript, ESLint, a production build, public/protected-route Playwright
smoke tests, and repository secret scanning. Authenticated E2E requires a
CAPTCHA-created disposable session via `E2E_STORAGE_STATE`; production CAPTCHA is
never bypassed.

Production operations, environment ownership, privacy-safe analytics, retention,
incident response, and launch status are documented in:

- [`docs/OPERATIONS_RUNBOOK.md`](docs/OPERATIONS_RUNBOOK.md)
- [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md)
- [`docs/ANALYTICS.md`](docs/ANALYTICS.md)
- [`docs/RETENTION_AND_RECOVERY.md`](docs/RETENTION_AND_RECOVERY.md)
- [`docs/INCIDENT_RESPONSE.md`](docs/INCIDENT_RESPONSE.md)
- [`docs/LAUNCH_MATRIX.md`](docs/LAUNCH_MATRIX.md)
- [`docs/PERFORMANCE_BASELINE.md`](docs/PERFORMANCE_BASELINE.md)
