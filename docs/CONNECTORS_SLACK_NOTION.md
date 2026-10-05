# Slack and Notion connector configuration

The implementation pins Slack OAuth v2/Web API/Events API and Notion API
`2026-03-11`. Notion requests use the first-class `/v1/data_sources` model.
The Slack Work OS v1 branch is an acceptance candidate deployed only to the
separate `crazyloops-staging` Vercel project. It must not be merged or deployed
to the customer production project until live acceptance passes.

## Slack owner actions

1. Use a dedicated staging-only Slack app and disposable workspace. Do not
   enable commercial distribution merely for this acceptance run.
2. Add this OAuth redirect URL exactly:
   `https://staging.crazy-loops.com/api/connectors/oauth/slack/callback`
   Do not use the customer production URL for this gate.
3. Keep OAuth PKCE disabled for this confidential server-side web application.
   OAuth state remains random,
   short-lived, encrypted-at-rest, owner-bound, and single-use.
4. Add only these bot scopes:
   - `channels:read` — list accessible public channels and retain their IDs.
   - `channels:history` — receive `message.channels` events from channels where
     the app is a member.
   - `chat:write` — send acknowledged channel messages and thread replies.
5. Under Event Subscriptions, set the Request URL exactly to
   `https://staging.crazy-loops.com/api/connectors/events/slack`.
   Do not point this acceptance app at production.
6. Subscribe the bot to `message.channels`. Do not add reaction or DM events;
   those operations are not advertised by this release.
7. Install/reinstall the app to the disposable acceptance workspace and invite
   it to the disposable public channel used by the test. No private/DM scope.
8. Configure these server-only values in the separate `crazyloops-staging`
   Vercel project only; do not change the customer production project:
   - `FLOWMIND_CONNECTOR_SLACK_CLIENT_ID`
   - `FLOWMIND_CONNECTOR_SLACK_CLIENT_SECRET`
   - `FLOWMIND_CONNECTOR_SLACK_SIGNING_SECRET`

Signed Events API messages are the sole inbound Work OS context. There is no
historical channel crawl. New commercially distributed non-Marketplace Slack
installs have especially tight `conversations.history`/`replies` limits, so
those APIs must not be used as a bulk fallback. A Slack `429` is surfaced with
its Retry-After classification; ambiguous writes are never retried blindly.

## Notion owner actions

1. Create a public Notion connection with installation scope appropriate for
   the acceptance workspace.
2. Add this OAuth redirect URL exactly:
   `https://www.crazy-loops.com/api/connectors/oauth/notion/callback`
3. Enable Read content, Insert content, and Update content capabilities. User
   information and comment capabilities are not used.
4. Create a connection webhook using API version `2026-03-11` and this URL:
   `https://www.crazy-loops.com/api/connectors/events/notion`
5. Subscribe only to `page.created`, `page.content_updated`,
   `page.properties_updated`, and `page.moved` for this release.
6. Before registering the webhook, temporarily set a random server-only
   `FLOWMIND_CONNECTOR_NOTION_SETUP_SECRET` of at least 32 characters and
   redeploy. Register the webhook URL; the unsigned initial verification body
   is accepted and its token is encrypted for at most 15 minutes.
7. Retrieve the token exactly once over HTTPS using an operator terminal:
   `curl -H "Authorization: Bearer $FLOWMIND_CONNECTOR_NOTION_SETUP_SECRET" https://www.crazy-loops.com/api/connectors/events/notion`
   Paste the returned `verification_token` into Notion. Do not run this command
   in browser code or share its output.
8. Set the captured value as
   `FLOWMIND_CONNECTOR_NOTION_WEBHOOK_VERIFICATION_TOKEN`, remove
   `FLOWMIND_CONNECTOR_NOTION_SETUP_SECRET`, and redeploy. Ordinary events then
   require a valid raw-body `X-Notion-Signature` HMAC.
9. Set these Vercel Production and active Preview variables, then redeploy:
   - `FLOWMIND_CONNECTOR_NOTION_CLIENT_ID`
   - `FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET`
   - `FLOWMIND_CONNECTOR_NOTION_WEBHOOK_VERIFICATION_TOKEN`
10. During OAuth, select only the disposable pages/data sources needed for live
   acceptance. A valid connection does not imply access to every workspace page.

## Live acceptance gate

Do not merge or deploy the Slack availability change until its real OAuth,
signed inbound event, grounded Ask, approval-backed send, duplicate,
ownership, and cleanup chain passes. Notion remains reviewed/unavailable.
No test-auth bypass or acceptance-only HTTP endpoint is permitted.
