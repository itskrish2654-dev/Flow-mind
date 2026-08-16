# Google connector deployment

Gmail and Google Sheets remain `BETA` until real production acceptance and Google verification are complete. Google Calendar and Google Drive are not supported.

## Separate Google projects

Use separate Google Cloud projects and OAuth clients for development/testing and production. Never copy disposable test credentials into Production. Store all secret values only in server-side environment variables.

Required server configuration:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_GMAIL_PUBSUB_TOPIC`
- `GOOGLE_PUBSUB_AUDIENCE`
- `GOOGLE_PUBSUB_SERVICE_ACCOUNT`

For the production domain, register these exact redirect URIs:

- `https://www.crazy-loops.com/api/connectors/oauth/google_gmail/callback`
- `https://www.crazy-loops.com/api/connectors/oauth/google_sheets/callback`

The authenticated Gmail Pub/Sub push endpoint is:

- `https://www.crazy-loops.com/api/connectors/events/google_gmail`

Set `GOOGLE_PUBSUB_AUDIENCE` to the exact audience configured on the push subscription. Set `GOOGLE_PUBSUB_SERVICE_ACCOUNT` to the exact service-account email whose signed OIDC token Pub/Sub sends. Grant Gmail's push service account permission to publish to `GOOGLE_GMAIL_PUBSUB_TOPIC`. Enable the Gmail API, Google Sheets API, and Pub/Sub API in the matching project.

## Least-privilege scope inventory

| Connector | Operation | Scope | Reason | Classification | Verification |
|---|---|---|---|---|---|
| Gmail | new email / matching search | `gmail.readonly` | Resolve mailbox history and normalize configured messages | Restricted | Required; pending |
| Gmail | send email | `gmail.send` | Send an explicitly configured message | Sensitive | Required; pending |
| Gmail | reply | `gmail.readonly` + `gmail.send` | Validate thread headers and send the reply | Restricted + sensitive | Required; pending |
| Google Sheets | add/find/update row | `drive.file` | Read/write only spreadsheets explicitly selected through Google Picker | Non-sensitive | Do not submit yet |

Google Sheets never accepts a pasted URL as permission. The user must reconnect
with `drive.file`, choose a spreadsheet through Google Picker, and CrazyLoops
stores that exact file grant server-side. Every inspect/read/write operation
revalidates the connection and the selected spreadsheet ID.

Picker configuration also requires `GOOGLE_PICKER_API_KEY` and the numeric
Google Cloud project number in `GOOGLE_PICKER_APP_ID`. Restrict the API key to
the Google Picker API and the exact production/preview HTTP referrers.

Identity scopes `openid` and `email` identify the selected Google account. CrazyLoops never requests `https://mail.google.com/`. Scopes are requested per operation, and later capabilities use incremental authorization against the same owner-bound connection.

## Owner actions before public launch

1. Configure the production OAuth consent screen, verified domain, privacy/data-use links, and test users.
2. Complete Google's verification/security-assessment process required by the requested Gmail scopes.
3. Configure the production Pub/Sub topic and authenticated push subscription exactly as above.
4. Add the five server environment variables to Vercel Production and separate values to Preview only if Preview is actively used.
5. Run the Phase 7B production acceptance with disposable Google and CrazyLoops accounts before changing either connector from `BETA` to `AVAILABLE`.

Owner/legal review is required for the added Google-data language in the Privacy and AI & Data Use pages.
