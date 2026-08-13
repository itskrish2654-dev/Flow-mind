# Privacy-safe analytics and telemetry

FlowMind stores bounded operational events in `operational_events` and product events in `product_analytics_events`. Both are service-only tables with forced RLS and no `anon` or `authenticated` grants. Vercel structured runtime logs are the fallback when telemetry storage is unavailable.

## Activation funnel

1. `signup_completed`
2. `dashboard_viewed`
3. `prompt_submitted`
4. one planner result: `planner_ready_to_compile`, `planner_needs_clarification`, `planner_unsupported`, or `planner_conflicting_requirements`
5. `workflow_created`
6. `workflow_configured`
7. `workflow_published`
8. `execution_started`
9. `execution_succeeded`
10. `second_workflow_created`

Drop-off and reliability events include `execution_failed`, `execution_partially_failed`, `execution_retry_attempted`, `execution_retry_succeeded`, `public_form_failed`, `ai_failed`, `pdf_failed`, and `quota_reached`. Step telemetry stores capability, status, sanitized category, and duration so operators can calculate AI/PDF failure rates and capability-level health without payload content.

## Privacy controls

User and anonymous identities are one-way HMAC hashes. Product properties use an explicit allowlist of categories, booleans, counts, and durations. Prompts, submissions, AI output, PDFs, document URLs, email addresses, credentials, authentication data, cookies, tokens, and secret/cipher fields are rejected from metadata. Operational errors are redacted centrally before database or runtime-log persistence.

Analytics is for aggregate product operation, not surveillance. Do not add raw payload properties to the allowlist. Retention duration remains an **OWNER/LEGAL DECISION REQUIRED**; until selected, events are not automatically deleted.
