# Data retention and recovery

## Implemented behavior

| Data | Current behavior |
| --- | --- |
| Workflow versions | Retained for immutable history until account deletion; no age-based cleanup |
| Execution history and step records | Retained until account deletion; no age-based cleanup |
| Generated private documents | Retained until workflow/account deletion; signed URLs expire, objects do not |
| Archived workflows | Retained with history; execution is blocked |
| Account deletion jobs | Durable failed/completed records remain for operations; interrupted jobs are flagged and safe failures are retried |
| Rate-limit rows | Removed only after their active window has ended and the additional 24-hour maintenance boundary has passed |
| Concurrency leases | Removed after TTL expiry |
| Operational events | No automatic deletion yet |
| Product analytics | No automatic deletion yet |

Exact retention periods for workflow/execution/document history, deletion-job audit records, operational events, and analytics are **OWNER/LEGAL DECISION REQUIRED**. The application does not silently delete customer history merely because it is old.

## Recovery boundaries

Database and Storage recovery depend on the enabled Supabase plan and project configuration. Operators must verify the project dashboard before promising backup, point-in-time recovery, or retention. FlowMind can retry interrupted execution/deletion state and can restore workflow intent from retained immutable versions; it cannot itself restore a deleted Auth identity, database row, or Storage object after provider retention is exhausted. Signed URLs are access grants, not backups.

Test restores in a disposable project and record the result/date. Never run destructive recovery exercises against customer data.
