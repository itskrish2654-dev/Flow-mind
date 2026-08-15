# Environment inventory

No secret value belongs in source control, browser storage, HTML, RSC payloads, logs, or client environment variables. Production and Preview values are configured in Vercel; local values belong only in `.env.local`.

| Variable | Class | Required | Production | Preview | Local | Purpose |
| --- | --- | --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Public | Yes | Yes | Yes | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public | Yes | Yes | Yes | Yes | Modern browser-safe Supabase key |
| `NEXT_PUBLIC_SITE_URL` | Public config | Yes in production | Yes | Optional; `VERCEL_URL` fallback | Yes | Canonical application origin |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Public | Yes | Yes | Yes | Yes | Cloudflare Turnstile widget site key |
| `SUPABASE_SECRET_KEY` | Server secret | Yes | Yes | Yes | Yes | Modern privileged backend key; bypasses RLS |
| `GROQ_API_KEY` | Server secret | Yes | Yes | Yes | Yes | Server-side AI provider authentication |
| `TURNSTILE_SECRET_KEY` | Server secret | Yes for costly public forms | Yes | Yes | Yes | Hosted-form Turnstile verification |
| `FLOWMIND_CREDENTIAL_MASTER_KEY` | Server secret | Yes | Yes | Yes | Yes | Canonical Base64 AES-256-GCM master key |
| `FLOWMIND_RATE_LIMIT_SECRET` | Server secret | Yes | Yes | Yes | Yes | HMAC identities for rate limits and telemetry |
| `CRON_SECRET` | Server secret | Yes | Yes | Yes if cron enabled | Yes | Authorizes maintenance cron |
| `FLOWMIND_AI_EXECUTION_MODEL` | Server config | Optional | Recommended | Recommended | Optional | Explicit Groq model; documented default applies |
| `FLOWMIND_AI_EXECUTION_TIMEOUT_MS` | Server config | Optional | Recommended | Recommended | Optional | AI request timeout |
| `FLOWMIND_AI_MAX_INPUT_CHARS` | Server config | Optional | Recommended | Recommended | Optional | AI input bound |
| `FLOWMIND_AI_MAX_OUTPUT_TOKENS` | Server config | Optional | Recommended | Recommended | Optional | AI output bound |
| `SUPPORT_EMAIL` | Server config | Configured | Yes | Recommended | Optional | Public support/privacy contact; defaults to `contact@crazy-loops.com` |
| `FLOWMIND_RELEASE` | Server config | Optional | No on Vercel | Optional | Optional | Release label when Git SHA is unavailable |

Forbidden legacy names: `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. Preview should use a separate Supabase project and separate secrets. If it intentionally shares Production resources, treat Preview deployments as production-trust code and document the risk.

Run `npm run validate:env` to validate the repository inventory. This checks names, not deployed values.
