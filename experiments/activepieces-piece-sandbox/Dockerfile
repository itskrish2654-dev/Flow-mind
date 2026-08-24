FROM docker.io/library/node:24.8.0-bookworm-slim@sha256:cadbfafeb6baf87eaaffa40b3640209c4b7fd38cebde65059d15bc39cd636b85

ARG SANDBOX_PUBLIC_KEY_B64

WORKDIR /sandbox
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY manifest.mjs protocol.mjs worker.mjs ./
RUN test -n "$SANDBOX_PUBLIC_KEY_B64" \
    && printf '%s' "$SANDBOX_PUBLIC_KEY_B64" | base64 -d > /sandbox/public-key.der \
    && chown -R 65532:65532 /sandbox \
    && chmod -R go-w /sandbox

ENV NODE_ENV=production
USER 65532:65532
ENTRYPOINT ["node", "/sandbox/worker.mjs"]
