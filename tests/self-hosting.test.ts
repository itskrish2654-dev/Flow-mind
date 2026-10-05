import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const nextConfig = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const dockerignore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");
const compose = readFileSync(new URL("../compose.self-host.yml", import.meta.url), "utf8");

test("self-hosting uses the traced standalone server and copies its static assets", () => {
  assert.match(nextConfig, /output:\s*["']standalone["']/);
  assert.match(dockerfile, /\/app\/\.next\/standalone/);
  assert.match(dockerfile, /\/app\/\.next\/static/);
  assert.match(dockerfile, /CMD \["node", "server\.js"\]/);
});

test("image build accepts only browser-safe arguments and excludes local secrets", () => {
  const args = [...dockerfile.matchAll(/^ARG\s+([A-Z0-9_]+)/gm)].map((match) => match[1]);
  assert.deepEqual(args.sort(), ["NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_TURNSTILE_SITE_KEY"].sort());
  assert.match(dockerignore, /^\.env\*$/m);
  assert.match(dockerignore, /^\*\*\/\.env\*$/m);
  assert.match(dockerignore, /^node_modules$/m);
  assert.match(dockerignore, /^\.next$/m);
});

test("runtime stays non-root and health checks application plus managed database", () => {
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /http:\/\/127\.0\.0\.1:3000\/api\/health/);
  assert.match(dockerfile, /body\.status!==['"]ok['"]\|\|body\.database!==['"]ok['"]/);
  assert.doesNotMatch(dockerfile, /COPY\s+.*\.env|ARG\s+(?:SUPABASE_SECRET_KEY|GROQ_API_KEY)/);
});

test("single app Compose service publishes only to loopback and injects runtime env", () => {
  assert.match(compose, /^services:\s*\n  crazyloops:/);
  assert.match(compose, /127\.0\.0\.1:\$\{CRAZYLOOPS_HOST_PORT:-3000\}:3000/);
  assert.match(compose, /CRAZYLOOPS_RUNTIME_ENV_FILE:\?/);
  assert.match(compose, /restart: unless-stopped/);
  assert.match(compose, /cap_drop:\s*\n\s+- ALL/);
  assert.doesNotMatch(compose, /^  (?:supabase|postgres|groq|nginx|caddy):/m);
});
