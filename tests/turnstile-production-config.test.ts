import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { classifyTurnstileError } from "../lib/turnstile-diagnostics";

test("Turnstile error 110200 is classified as a hostname authorization failure", () => {
  assert.equal(classifyTurnstileError("110200"), "hostname_not_authorized");
  assert.equal(classifyTurnstileError("script_load_failure"), "script_load_failure");
});

test("auth widget captures the real Cloudflare client code without a token", async () => {
  const source = await readFile(new URL("../components/auth-turnstile.tsx", import.meta.url), "utf8");
  assert.match(source, /"error-callback": \(errorCode: string\) => void/);
  assert.match(source, /reportFailure\(errorCode \|\| "unknown_error"\)/);
  assert.match(source, /window\.location\.hostname/);
  assert.match(source, /window\.location\.pathname/);
  assert.doesNotMatch(source, /reportTurnstileClientError\(\{[\s\S]*token:/);
});

test("Turnstile diagnostic action stores only bounded safe context", async () => {
  const source = await readFile(new URL("../app/actions/turnstile.ts", import.meta.url), "utf8");
  for (const field of ["errorCode", "hostname", "page", "browserCategory", "correlationId"]) {
    assert.match(source, new RegExp(field));
  }
  assert.match(source, /enforceRateLimit/);
  assert.doesNotMatch(source, /siteKey|sitekey|secret|password|cookie|captchaToken/);
});

test("CSP authorizes only the required Cloudflare challenge origin", async () => {
  const source = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
  const challengeOriginOccurrences = source.match(/https:\/\/challenges\.cloudflare\.com/g) ?? [];
  assert.ok(challengeOriginOccurrences.length >= 3);
  assert.match(source, /script-src[^\n]*https:\/\/challenges\.cloudflare\.com/);
  assert.match(source, /connect-src[^\n]*https:\/\/challenges\.cloudflare\.com/);
  assert.match(source, /frame-src[^\n]*https:\/\/challenges\.cloudflare\.com/);
  assert.doesNotMatch(source, /https:\/\/\*\.cloudflare\.com/);
});
