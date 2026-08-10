# FlowMind

FlowMind is a Next.js 16 automation builder backed by Supabase Auth, Postgres Row Level Security, and Groq.

## Local setup

1. Copy `.env.example` to `.env.local`. The Supabase service role, Groq key,
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

Open [http://localhost:3000](http://localhost:3000). Unauthenticated dashboard requests redirect to `/login`.

## Security model

- Supabase sessions are stored in cookies through `@supabase/ssr`.
- Next.js `proxy.ts` refreshes sessions and protects every `/dashboard` route.
- Every Server Action independently verifies the user with `supabase.auth.getUser()`.
- Every owner query includes the authenticated `user_id`.
- Authenticated browser roles can read only owner-scoped workflows and executions.
  Workflow mutations and trusted execution inserts use server actions and a
  server-only service role so quotas, publication, and derived fields cannot be bypassed.
- Connector credentials use AES-256-GCM with a unique nonce, authenticated owner/
  workflow/connector context, and ciphertext version metadata. Plaintext is never
  returned after submission. Version 1 supports one active environment master key;
  rotate by decrypting and re-encrypting records before replacing that key. Automatic
  multi-key rotation is intentionally deferred.
- Rate limits, monthly usage counters, and concurrency leases are stored atomically
  in Postgres and fail closed when unavailable.
- Generated PDFs use a private bucket. Owners receive signed download links that
  expire after 15 minutes. Workflow deletion removes its recorded files; account-level
  storage garbage collection remains a later retention task.
- Hosted forms are private by default and require explicit Publish / Unpublish actions.

## Verification

```bash
npm run lint
npm run build
npm run verify:rls
```

`verify:rls` must report zero anonymous rows or a 401/403 response before deployment.
