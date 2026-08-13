# Security incident response

For every incident: contain first, preserve sanitized evidence and deployment IDs, assign an incident owner, record times/actions, communicate only verified facts, and obtain legal advice before making notification claims.

| Incident | Immediate containment | Recovery and investigation |
| --- | --- | --- |
| Supabase secret exposed | Revoke the key, stop affected deployments/jobs, create a new server secret | Update each environment, redeploy, prove the old key fails, audit privileged operations and data access |
| Groq key exposed | Revoke at Groq and pause AI execution if needed | Replace server secret, redeploy, review provider usage and `ai_failed`/execution telemetry |
| Credential master key exposed | Disable connector execution and restrict privileged access | Inventory affected ciphertext, rotate by controlled decrypt/re-encrypt, invalidate connector credentials where possible, investigate access logs |
| Turnstile secret exposed | Rotate the Cloudflare secret and keep costly forms fail-closed | Update Supabase Auth and Vercel, redeploy, inspect public-form/auth abuse events |
| Suspected cross-user leak | Disable affected operation/public access; do not delete evidence | Test RLS plus service-role ownership checks with disposable A/B accounts, scope affected records, patch and verify before restoration |
| Spam or abuse attack | Unpublish targeted forms or tighten provider controls | Review hashed IP/workflow rate events, quota impact, Turnstile effectiveness, and distributed-source patterns |
| Compromised user credential | Revoke the user's sessions and disable public forms/credentials if requested | Require password recovery, inspect account activity, rotate affected connector credentials |

Account deletion and public-access revocation must remain fail-closed during recovery. Never put keys, tokens, cookies, credential plaintext/ciphertext, prompt bodies, submission bodies, or private document URLs in incident records.
