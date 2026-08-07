# FlowMind

FlowMind is a Next.js 16 automation builder backed by Supabase Auth, Postgres Row Level Security, and Groq.

## Local setup

1. Copy `.env.example` to `.env.local` and provide the public Supabase URL and publishable key plus the server-only Groq key.
2. Apply the migrations to the linked Supabase project. If this folder is not linked yet:

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

The ownership migration is in `supabase/migrations/20260807000100_workflow_ownership_rls.sql`. Existing workflows without a `user_id` intentionally become inaccessible after the migration; assign an owner manually only when that ownership is known.

3. Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Unauthenticated dashboard requests redirect to `/login`.

## Security model

- Supabase sessions are stored in cookies through `@supabase/ssr`.
- Next.js `proxy.ts` refreshes sessions and protects every `/dashboard` route.
- Every Server Action independently verifies the user with `supabase.auth.getUser()`.
- Every workflow query includes the authenticated `user_id`.
- Postgres RLS policies restrict SELECT, INSERT, UPDATE, and DELETE to the owning user.
- No Supabase service-role key is used by the application.

## Verification

```bash
npm run lint
npm run build
npm run verify:rls
```

`verify:rls` must report zero anonymous rows or a 401/403 response before deployment.
