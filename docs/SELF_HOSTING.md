# CrazyLoops single-instance self-hosting

This packages the accepted Work OS RC as one Next.js container on Ubuntu amd64. It does not deploy the app, migrate the database, or configure a reverse proxy/tunnel. Managed Supabase and the external Groq API remain separate services. Do not point a trial deployment at customer production resources.

## Configuration boundaries

- Build with only the four `NEXT_PUBLIC_*` values listed in `compose.self-host.yml`. Next.js inlines them into browser assets, so rebuild the image when any of them changes. `NEXT_PUBLIC_SITE_URL` must be the eventual canonical HTTPS origin when the app is placed behind a private proxy/tunnel; do not use the loopback bind address as a public OAuth callback URL.
- Put runtime variables in a host-only file outside the Git checkout, for example `/etc/crazyloops/runtime.env`, readable by the Docker administrator only (`chmod 600`). Use the names in `.env.example` and `docs/ENVIRONMENT.md`. Include the same four public values plus required server-only Supabase, Groq, encryption, limiter, auth and scheduling values. Keep deferred connector/runner flags disabled unless independently accepted.
- No server secret is a Docker build argument, copied into the build context, or committed. `.dockerignore` excludes environment files. The runtime file is passed by Compose when the container starts; Docker administrators can inspect container environment variables, so restrict Docker and host access accordingly. Do not print `docker compose config` without `--quiet` or include environment values in logs.
- `/api/health` checks the managed database and returns 200 only when the application and database are available. Set `VERCEL_GIT_COMMIT_SHA` in the runtime file to the deployed Git SHA if the existing health response should show a release instead of `local`.

## Build and start on the Ubuntu server later

The commands below are for the owner to run **after separate deployment authorization**, not steps performed by this foundation task. Place the approved branch checkout at `/opt/crazyloops`; create `/etc/crazyloops/runtime.env` out of band with the authorized non-production environment and mode `600`. The file must contain `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL`, and any `NEXT_PUBLIC_TURNSTILE_SITE_KEY` used by the browser. The first three are required at build time.

```bash
cd /opt/crazyloops
export CRAZYLOOPS_RUNTIME_ENV_FILE=/etc/crazyloops/runtime.env
docker compose --env-file "$CRAZYLOOPS_RUNTIME_ENV_FILE" -f compose.self-host.yml config --quiet
docker compose --env-file "$CRAZYLOOPS_RUNTIME_ENV_FILE" -f compose.self-host.yml build --pull
docker compose --env-file "$CRAZYLOOPS_RUNTIME_ENV_FILE" -f compose.self-host.yml up -d --no-build
docker compose --env-file "$CRAZYLOOPS_RUNTIME_ENV_FILE" -f compose.self-host.yml ps
curl --fail --silent --show-error http://127.0.0.1:3000/api/health
```

Compose publishes container port 3000 to **host loopback only** (`127.0.0.1:3000` by default). Set `CRAZYLOOPS_HOST_PORT` before these commands if that host port is already used. The app listens on `0.0.0.0` only inside the container. No public host interface, database, Groq process, proxy, tunnel, or Docker socket is included. Docker restarts the container unless it is explicitly stopped. The image runs `server.js` as the unprivileged `node` user and checks `/api/health` from inside the container.

For a later update, check out the approved SHA, rebuild, and run `up -d --no-build` again. This is a single-instance deployment; do not add replicas without reviewing Next.js cache and Server Function key coordination. The application image is ephemeral—business records and documents live in managed Supabase, while local Next.js cache can be regenerated.
