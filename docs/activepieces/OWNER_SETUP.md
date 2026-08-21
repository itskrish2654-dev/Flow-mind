# CrazyLoops delegated bridge owner setup

This is an internal operations component. Keep both CrazyLoops feature flags disabled until every step below is complete and the echo probe passes. Never expose the worker editor or its webhook URL in the CrazyLoops product.

## 1. Oracle VM

1. Create a dedicated Oracle Linux or Ubuntu VM with a static public IP.
2. In the Oracle VCN security list, allow inbound TCP 22 only from the owner's administration IP and TCP 80/443 from the internet. Do not expose Activepieces port 8080 publicly.
3. Point a dedicated DNS record such as `worker.crazy-loops.com` to that static IP.
4. Install current Docker Engine, Docker Compose v2, Git, Nginx, and Certbot from their vendor-supported repositories.

## 2. Activepieces Docker Compose

1. Follow the official Docker Compose deployment: clone `https://github.com/activepieces/activepieces.git`, enter the directory, run `sh tools/deploy.sh`, and review the generated `.env` before starting.
2. Set `AP_FRONTEND_URL=https://worker.crazy-loops.com`.
3. Generate a random bridge secret of at least 32 bytes. Store it only in the Activepieces host `.env` as `CRAZYLOOPS_BRIDGE_SECRET` and in Vercel as `ACTIVEPIECES_BRIDGE_SECRET`.
4. Add `CRAZYLOOPS_BRIDGE_SECRET` to `AP_SANDBOX_PROPAGATED_ENV_VARS` so only that named variable is made available to the worker code sandbox.
5. Use PostgreSQL and Redis from the official Compose production shape; use unique strong database, JWT, and encryption secrets. Back up the database volume.
6. Start with `docker compose -p activepieces up -d` and confirm the containers are healthy.

## 3. HTTPS

1. Configure Nginx to proxy `worker.crazy-loops.com` to `127.0.0.1:8080`.
2. Issue a certificate with Certbot and force HTTP to HTTPS.
3. Confirm the public origin uses a valid certificate and does not expose port 8080.

## 4. Import and publish the worker

1. Sign in to the private Activepieces instance as its owner.
2. Import `docs/activepieces/crazyloops-bridge-worker-v1.json`.
3. Verify the worker contains exactly: Catch Webhook → Authenticate and validate envelope → Return normalized response.
4. Confirm both action steps have automatic retry disabled.
5. Publish the worker, copy its live synchronous webhook URL, and append `/sync` if the UI did not already provide the synchronous form.
6. Test an invalid unsigned request. It must return 403 and must not echo input.

## 5. Vercel Production configuration

Set these server-only variables in the CrazyLoops Production environment (and Preview only if Preview is intentionally connected to this private worker):

```text
DELEGATED_EXECUTION_ENABLED=false
ACTIVEPIECES_EXECUTOR_ENABLED=false
ACTIVEPIECES_BRIDGE_URL=https://worker.crazy-loops.com/<published-live-webhook-path>/sync
ACTIVEPIECES_BRIDGE_SECRET=<same random secret as the worker host>
ACTIVEPIECES_BRIDGE_TIMEOUT_MS=10000
```

Redeploy with both flags still false. Run the internal echo acceptance probe. Only after it passes, change both flags to `true` and redeploy. Disabling either flag is the immediate kill switch.

## 6. Rotation and operations

- Rotate the bridge secret by updating the worker host first while the feature flags are disabled, restart the worker, update Vercel, redeploy, retest, then re-enable.
- Monitor CrazyLoops `delegated_request_*` telemetry and Activepieces worker health. Never log request bodies, response bodies, or the secret.
- CrazyLoops owns business retries. Keep retry disabled in this worker.
- The worker accepts only protocol v1 and `internal.bridge_echo`; do not add customer integrations to this template.

## 7. Admin and webhook exposure boundary

Before any real customer credential can reach delegated infrastructure, remove
general public access to the Activepieces editor. Keep the published synchronous
webhook reachable by CrazyLoops, while owner/editor access uses a private network,
SSH tunnel, or a separately tested private admin hostname. Port 8080 remains
private.

Do not place Cloudflare Access or another interactive challenge over the entire
worker hostname: that would also intercept the webhook, and Activepieces UI,
Socket.IO, API, and absolute URL behavior may depend on `AP_FRONTEND_URL`. Prefer
a public reverse-proxy allowlist for the exact published webhook path and a private
owner route. Validate the exact Activepieces 0.88.3 paths on staging before
changing the production proxy. See `DELEGATED_CREDENTIAL_MODEL.md` for the audited
credential and routing constraints.

Official references: [Activepieces Docker Compose](https://www.activepieces.com/docs/install/options/docker-compose), [Activepieces HTTPS](https://www.activepieces.com/docs/install/configure-operate/setup-ssl), and [Activepieces webhook limits](https://www.activepieces.com/docs/install/reference/limits).
