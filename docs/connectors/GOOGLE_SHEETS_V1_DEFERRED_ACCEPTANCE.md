# Google Sheets v1 engineering checkpoint

**Status: Google Sheets v1 engineering complete — live provider acceptance deferred.**

This checkpoint is deterministic engineering only. It does not establish that Google OAuth, Google Picker, Ask retrieval, or a Google Sheets write has succeeded against a real provider. Do not describe the connector as live-accepted or enable it for customers on the basis of this checkpoint.

Resume the dedicated Integration Acceptance mission on `codex/work-os-google-sheets-v1` against `https://staging.crazy-loops.com` and the authorized acceptance Supabase project `gamdxwtgccluifatcrrs`. Keep `www.crazy-loops.com`, the production Vercel project, and `main` untouched. Use a disposable Google account and spreadsheet; do not use customer data. The Google Picker API key and Cloud project number may be configured at that time, not for this engineering checkpoint. Reconfirm that staging uses the acceptance project before creating fixtures.

The acceptance database already has migration #42, `20261001000000_work_os_slack_v1`, from paused Slack work. Its exact SQL is carried into this Sheets branch to keep local migration history aligned, without importing the unaccepted Slack application implementation or reapplying the migration. Sheets v1 adds no migration. The paused Slack implementation remains in `stash@{0}` (`8a700a49d15c5d94e7966441475ff2830d96e94e`) and is not accepted here.

## Remaining live-provider checklist

Use real authenticated staging sessions and the real Picker. Do not insert a spreadsheet ID directly to simulate selection.

1. Complete real Google OAuth on staging using the intended testing client and `drive.file` scope.
2. Open Google Picker and explicitly select one disposable spreadsheet.
3. Verify the selection persists after browser refresh, including account, connection, spreadsheet, metadata, and worksheet discovery.
4. Verify an unselected spreadsheet is denied, including a manually supplied or forged spreadsheet ID.
5. Ask a question whose answer comes from actual bounded spreadsheet rows.
6. Verify the answer has a grounded spreadsheet, worksheet, and row/range source reference and truthfully marks partial results.
7. Verify a unique exact header/value row lookup.
8. Verify multiple exact matches cause ambiguity/clarification rather than first-row selection.
9. Place an inert prompt-injection string in a disposable cell; verify it remains data and triggers no action or secret disclosure.
10. Ask to add one row and verify the selected spreadsheet, worksheet, existing headers, and exact values in the preview before any write.
11. Approve the immutable add-row snapshot and verify exactly one real append.
12. Verify Google's acknowledgement and exact updated range/row are persisted; Ask, Activity, and My Day distinguish approval from confirmed success.
13. Ask to update one uniquely identified row; verify the target row and exact changed fields are frozen in the preview before any write.
14. Approve and verify exactly one real update with the provider acknowledgement persisted; unchanged cells and formulas remain intact.
15. Exercise double approval, two tabs, browser retry, server replay, and lost/ambiguous provider acknowledgement without a duplicate automatic write or a false success claim.
16. Verify issued-session owner access, cross-user and cross-workspace isolation, forged connection/resource denial, and that provider tokens never reach browser responses or logs.
17. Verify reconnect, revoked permission, deleted spreadsheet, and wrong Google account fail closed with accurate recovery guidance.
18. Check the connection and Picker UX, Ask sources, action preview/approval/outcome, refresh/recovery, and basic mobile layout in a browser.
19. Review staging runtime errors and Supabase security/performance advisors; distinguish pre-existing findings from new Sheets findings.
20. Clean disposable spreadsheet rows/resources and application fixtures. Explicitly query final counts for auth users, workspaces, memberships, Work Items, approvals, Ask threads/messages/turns, action executions, connector connections, connector credentials, and `google_selected_spreadsheets`.

One real append and one real update are sufficient. Do not add automated row-to-Work-Item intake or fake Sheets event polling to satisfy this checklist.

Live acceptance can be reported only after every applicable item is evidenced, cleanup succeeds, and the final staging/production separation is rechecked.
