# Performance and cost baseline

Measured from India against the pre-Phase-6 Production deployment on 2026-08-13 using uncached command-line requests:

| Surface | Approximate response time |
| --- | ---: |
| Login | 0.66 s |
| Anonymous dashboard redirect plus login | 0.39 s |
| Static privacy page | 0.13 s |
| Missing public-form lookup (database-backed 404) | 2.24 s |

The public-form database lookup is the slowest measured public read and should be watched after deployment. Authenticated dashboard, workflow load, prompt compilation, real AI execution, and PDF generation require a disposable authenticated production session and are measured through execution telemetry rather than synthetic requests. Unit PDF baselines generate common Unicode documents in roughly 0.1–0.2 s and a long multi-page fixture in roughly 1–2 s on the local development machine. Provider/network latency remains variable.

## Free-tier usage exposure

One Free account is bounded to 25 active workflows, 500 monthly executions, 300 monthly public submissions, 100 AI generations, 1,000,000 AI input characters, 100,000 AI output tokens, 100 generated documents/uploads, and 50 MiB of document storage. Durable quotas and per-user/workflow concurrency prevent one account from multiplying these limits through races. This is a usage exposure statement, not a monetary forecast.

Review aggregate execution durations, AI/PDF failure events, quota events, public-form rejection patterns, function usage, database size, and Storage usage after launch. Do not increase limits without a provider-cost and abuse review.
