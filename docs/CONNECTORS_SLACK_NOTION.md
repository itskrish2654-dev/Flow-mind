# Slack and Notion connector configuration

The implementation pins Slack OAuth v2/Web API/Events API and Notion API
`2026-03-11`. Notion requests use the first-class `/v1/data_sources` model. Both
connectors remain `BETA` until the live acceptance scenarios are completed.

## Slack owner actions

1. Create or open the CrazyLoops Slack app and enable distribution.
2. Add this OAuth redirect URL exactly:
   `https://www.crazy-loops.com/api/connectors/oauth/slack/callback`
3. Enable OAuth PKCE.
4. Add only these bot scopes:
   - `channels:read` — list accessible public channels and retain their IDs.
   - `channels:history` — receive `message.channels` events from channels where
     the app is a member.
   - `chat:write` — send acknowledged channel messages and thread replies.
5. Under Event Subscriptions, set the Request URL exactly to:
   `https://www.crazy-loops.com/api/connectors/events/slack`
6. Subscribe the bot to `message.channels`. Do not add reaction or DM events;
   those operations are not advertised by this release.
7. Install/reinstall the app to the disposable acceptance workspace and invite
   the app to each test channel used by a trigger or action.
8. Set these Vercel Production and active Preview variables, then redeploy:
   - `FLOWMIND_CONNECTOR_SLACK_CLIENT_ID`
   - `FLOWMIND_CONNECTOR_SLACK_CLIENT_SECRET`
   - `FLOWMIND_CONNECTOR_SLACK_SIGNING_SECRET`

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
6. Capture Notion's one-time webhook verification token through the developer
   dashboard's verification flow, set it as the server-only variable below,
   and complete endpoint verification. Never put it in a browser variable.
7. Set these Vercel Production and active Preview variables, then redeploy:
   - `FLOWMIND_CONNECTOR_NOTION_CLIENT_ID`
   - `FLOWMIND_CONNECTOR_NOTION_CLIENT_SECRET`
   - `FLOWMIND_CONNECTOR_NOTION_WEBHOOK_VERIFICATION_TOKEN`
8. During OAuth, select only the disposable pages/data sources needed for live
   acceptance. A valid connection does not imply access to every workspace page.

## Live acceptance gate

Do not change either registry status from `BETA` to `AVAILABLE` until real Slack
and Notion installations pass the Phase 7B-2 OAuth, inbound event, outbound
acknowledgement, duplicate, reconnect, disconnect, A/B isolation, and cleanup
scenarios. No test-auth bypass or acceptance-only HTTP endpoint is permitted.
