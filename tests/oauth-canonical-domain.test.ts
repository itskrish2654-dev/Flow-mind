import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CANONICAL_PRODUCTION_ORIGIN,
  LEGACY_PRODUCTION_ORIGIN,
  resolveSiteOrigin,
} from "../lib/site-origin";
import { getPublicFormUrl } from "../lib/public-form";

const callback = (connectorId: string) => new URL(
  `/api/connectors/oauth/${connectorId}/callback`,
  resolveSiteOrigin({
    siteUrl: LEGACY_PRODUCTION_ORIGIN,
    vercelEnvironment: "production",
  }),
).toString();

test("Production always resolves to the canonical CrazyLoops origin", () => {
  assert.equal(
    resolveSiteOrigin({
      siteUrl: LEGACY_PRODUCTION_ORIGIN,
      vercelEnvironment: "production",
    }),
    CANONICAL_PRODUCTION_ORIGIN,
  );
  assert.equal(
    resolveSiteOrigin({
      siteUrl: "https://unexpected-deployment.example",
      vercelEnvironment: "production",
    }),
    CANONICAL_PRODUCTION_ORIGIN,
  );
});

test("all current and future connector callbacks share the canonical route builder", () => {
  assert.equal(callback("slack"), "https://www.crazy-loops.com/api/connectors/oauth/slack/callback");
  assert.equal(callback("notion"), "https://www.crazy-loops.com/api/connectors/oauth/notion/callback");
  assert.equal(callback("google_sheets"), "https://www.crazy-loops.com/api/connectors/oauth/google_sheets/callback");
  assert.equal(callback("google_gmail"), "https://www.crazy-loops.com/api/connectors/oauth/google_gmail/callback");
  assert.equal(callback("future_provider"), "https://www.crazy-loops.com/api/connectors/oauth/future_provider/callback");
});

test("known legacy origins are rewritten for generated public form URLs", () => {
  const previous = process.env.NEXT_PUBLIC_SITE_URL;
  process.env.NEXT_PUBLIC_SITE_URL = LEGACY_PRODUCTION_ORIGIN;
  try {
    assert.equal(
      getPublicFormUrl("00000000-0000-4000-8000-000000000001"),
      "https://www.crazy-loops.com/f/00000000-0000-4000-8000-000000000001",
    );
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = previous;
  }
});

test("OAuth, auth, recovery, and webhook server paths use the shared origin resolver", async () => {
  const files = await Promise.all([
    readFile("app/api/connectors/oauth/[connectorId]/start/route.ts", "utf8"),
    readFile("app/api/connectors/oauth/[connectorId]/callback/route.ts", "utf8"),
    readFile("app/actions/auth.ts", "utf8"),
    readFile("app/auth/callback/route.ts", "utf8"),
    readFile("app/auth/recovery/route.ts", "utf8"),
    readFile("lib/connectors/subscriptions.ts", "utf8"),
  ]);
  for (const source of files) {
    assert.match(source, /getSiteOrigin|getSiteUrl/);
    assert.doesNotMatch(source, /flow-mind-beta\.vercel\.app/i);
  }
});

test("homepage, metadata, sitemap, robots, legal pages, and connector docs use CrazyLoops", async () => {
  const files = await Promise.all([
    readFile("app/layout.tsx", "utf8"),
    readFile("app/page.tsx", "utf8"),
    readFile("app/sitemap.ts", "utf8"),
    readFile("app/robots.ts", "utf8"),
    readFile("docs/connectors/google.md", "utf8"),
    readFile("docs/CONNECTORS_SLACK_NOTION.md", "utf8"),
  ]);
  for (const source of files) assert.match(source, /https:\/\/www\.crazy-loops\.com/);
});
