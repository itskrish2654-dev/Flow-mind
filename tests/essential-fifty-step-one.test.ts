import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import nock from "nock";

import {
  HUBSPOT_GET_CONTACT_ACTION,
  HUBSPOT_GET_CONTACT_CAPABILITY,
  HUBSPOT_PIECE_PACKAGE,
  HUBSPOT_PIECE_VERSION,
  PieceExecutionError,
  executePinnedHubSpotGetContact,
  loadPinnedHubSpotAction,
  resolveExperimentCapability,
} from "../experiments/activepieces-piece-runner/adapter";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(TEST_DIRECTORY, "..");

function mockGetContact(
  contactId: string,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return nock("https://api.hubapi.com")
    .get(new RegExp(`/crm/v3/objects/contacts/${contactId}`))
    .query(true)
    .reply(status, body, headers);
}

async function expectPieceError(
  run: () => Promise<unknown>,
  code: string,
) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof PieceExecutionError);
    assert.equal(error.code, code);
    return true;
  });
}

test.afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

test("exact pinned HubSpot piece and read-only action load", () => {
  const resolved = resolveExperimentCapability(HUBSPOT_GET_CONTACT_CAPABILITY);
  assert.deepEqual(resolved, {
    packageName: HUBSPOT_PIECE_PACKAGE,
    packageVersion: HUBSPOT_PIECE_VERSION,
    actionName: HUBSPOT_GET_CONTACT_ACTION,
  });
  const action = loadPinnedHubSpotAction();
  assert.equal(action.name, "get-contact");
  assert.equal(action.classification, "READ");
  assert.equal(typeof action.run, "function");

  const lock = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; integrity?: string }>;
  };
  const locked = lock.packages["node_modules/@activepieces/piece-hubspot"];
  assert.equal(locked.version, "0.8.10");
  assert.equal(
    locked.integrity,
    "sha512-P3svTd/XaaPhYfsOSz6YpgdfNcARRawqAddBGtJUxW/Grbc5InTdsvddlgSdyQtJxH+3UpxrKAR1VjlGJ4hfNA==",
  );
});

test("unknown capability/action selection is rejected before the piece runs", async () => {
  await expectPieceError(
    () => executePinnedHubSpotGetContact({
      capability: "hubspot.user_supplied_action@1",
      props: { contactId: "contact-123" },
      credential: Buffer.from("unused"),
    }),
    "ACTION_NOT_ALLOWED",
  );
  assert.equal(nock.pendingMocks().length, 0);
});

test("fake credential reaches only the mocked provider and response is normalized", async () => {
  nock.disableNetConnect();
  const canary = `E50_TEST_${randomBytes(24).toString("hex")}`;
  let authMatched = false;
  nock("https://api.hubapi.com")
    .get(/\/crm\/v3\/objects\/contacts\/contact-123/)
    .query(true)
    .matchHeader("authorization", (value) => {
      authMatched = String(value) === `Bearer ${canary}`;
      return authMatched;
    })
    .reply(200, {
      id: "contact-123",
      properties: { email: "reader@example.test", firstname: "Casey" },
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:01:00.000Z",
      archived: false,
    });

  const credential = Buffer.from(canary);
  const result = await executePinnedHubSpotGetContact({
    capability: HUBSPOT_GET_CONTACT_CAPABILITY,
    props: { contactId: "contact-123", additionalPropertiesToRetrieve: ["firstname"] },
    credential,
  });

  assert.equal(authMatched, true);
  assert.equal(result.acknowledged, true);
  assert.equal(result.output.contactId, "contact-123");
  assert.equal(result.output.properties.email, "reader@example.test");
  assert.ok(credential.every((byte) => byte === 0));
  assert.equal(nock.isDone(), true);
});

test("provider 401 is normalized without provider body or credential leakage", async () => {
  nock.disableNetConnect();
  mockGetContact("contact-401", 401, { status: "error", message: "credential was bad" });
  await expectPieceError(
    () => executePinnedHubSpotGetContact({
      capability: HUBSPOT_GET_CONTACT_CAPABILITY,
      props: { contactId: "contact-401" },
      credential: Buffer.from(`E50_401_${randomBytes(20).toString("hex")}`),
    }),
    "PROVIDER_AUTHENTICATION_FAILED",
  );
});

test("provider 429 and retry-after are normalized", async () => {
  nock.disableNetConnect();
  mockGetContact("contact-429", 429, { status: "error" }, { "Retry-After": "2" });
  await assert.rejects(
    () => executePinnedHubSpotGetContact({
      capability: HUBSPOT_GET_CONTACT_CAPABILITY,
      props: { contactId: "contact-429" },
      credential: Buffer.from("fake-token"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof PieceExecutionError);
      assert.equal(error.code, "PROVIDER_RATE_LIMITED");
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterMs, 2_000);
      return true;
    },
  );
});

test("provider 5xx is normalized as retryable unavailable", async () => {
  nock.disableNetConnect();
  mockGetContact("contact-500", 503, { status: "error" });
  await assert.rejects(
    () => executePinnedHubSpotGetContact({
      capability: HUBSPOT_GET_CONTACT_CAPABILITY,
      props: { contactId: "contact-500" },
      credential: Buffer.from("fake-token"),
    }),
    (error: unknown) => {
      assert.ok(error instanceof PieceExecutionError);
      assert.equal(error.code, "PROVIDER_UNAVAILABLE");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("timeout and malformed response fail safely", async () => {
  nock.disableNetConnect();
  nock("https://api.hubapi.com")
    .get(/\/crm\/v3\/objects\/contacts\/contact-slow/)
    .query(true)
    .delay(100)
    .reply(200, { id: "contact-slow", properties: {} });
  await expectPieceError(
    () => executePinnedHubSpotGetContact({
      capability: HUBSPOT_GET_CONTACT_CAPABILITY,
      props: { contactId: "contact-slow" },
      credential: Buffer.from("fake-token"),
      timeoutMs: 10,
    }),
    "PROVIDER_TIMEOUT",
  );

  mockGetContact("contact-malformed", 200, { unexpected: true });
  await expectPieceError(
    () => executePinnedHubSpotGetContact({
      capability: HUBSPOT_GET_CONTACT_CAPABILITY,
      props: { contactId: "contact-malformed" },
      credential: Buffer.from("fake-token"),
    }),
    "MALFORMED_PROVIDER_RESPONSE",
  );
});

test("selected piece follows redirects, proving provider egress must be enforced outside the piece", async () => {
  nock.disableNetConnect();
  let redirectedHostReached = false;
  nock("https://api.hubapi.com")
    .get(/\/crm\/v3\/objects\/contacts\/contact-redirect/)
    .query(true)
    .reply(302, undefined, { Location: "https://redirect-target.example/contact" });
  nock("https://redirect-target.example")
    .get("/contact")
    .reply(() => {
      redirectedHostReached = true;
      return [200, { id: "contact-redirect", properties: {}, archived: false }];
    });

  const result = await executePinnedHubSpotGetContact({
    capability: HUBSPOT_GET_CONTACT_CAPABILITY,
    props: { contactId: "contact-redirect" },
    credential: Buffer.from("fake-token"),
  });
  assert.equal(result.output.contactId, "contact-redirect");
  assert.equal(redirectedHostReached, true);
});

test("canary probe uses no Activepieces service/state and persists no plaintext", () => {
  const canary = `CRAZYLOOPS_E50_CANARY_${randomBytes(32).toString("hex")}`;
  const canaryTemp = mkdtempSync(join(tmpdir(), "crazyloops-e50-canary-"));
  const tsxCli = require.resolve("tsx/cli");
  const probe = join(REPOSITORY_ROOT, "experiments/activepieces-piece-runner/canary-probe.ts");
  const child = spawnSync(process.execPath, [tsxCli, probe], {
    cwd: REPOSITORY_ROOT,
    input: canary,
    encoding: "utf8",
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: canaryTemp,
      TMP: canaryTemp,
    },
    timeout: 20_000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.includes(canary), false);
  assert.equal(child.stderr.includes(canary), false);
  const result = JSON.parse(child.stdout.trim()) as Record<string, unknown>;
  assert.equal(result.credentialReachedProvider, true);
  assert.equal(result.normalizedContactId, "contact-123");
  assert.equal(result.safeErrorCode, "PROVIDER_AUTHENTICATION_FAILED");
  assert.equal(result.pendingMocks, 0);
  assert.equal(result.activepiecesServerInvolved, false);
  assert.equal(result.activepiecesDatabaseInvolved, false);
  assert.equal(result.activepiecesConnectionInvolved, false);

  const serializedInput = JSON.stringify({
    capability: HUBSPOT_GET_CONTACT_CAPABILITY,
    props: { contactId: "contact-123" },
  });
  assert.equal(serializedInput.includes(canary), false);
  assert.equal(JSON.stringify(result).includes(canary), false);

  const diff = spawnSync("git", ["diff", "--no-ext-diff"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  assert.equal(`${diff.stdout}${diff.stderr}`.includes(canary), false);

  const scanRoots = [
    join(REPOSITORY_ROOT, "experiments/activepieces-piece-runner"),
    join(REPOSITORY_ROOT, "tests"),
    canaryTemp,
  ];
  let plaintextOccurrences = 0;
  const visit = (path: string) => {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      for (const childPath of readdirSync(path)) visit(join(path, childPath));
      return;
    }
    if (stats.size <= 2 * 1024 * 1024) {
      plaintextOccurrences += readFileSync(path).toString("utf8").split(canary).length - 1;
    }
  };
  try {
    for (const root of scanRoots) visit(root);
    assert.equal(plaintextOccurrences, 0);
  } finally {
    rmSync(canaryTemp, { recursive: true, force: true });
  }
});

test("experiment is not registered in production capability, connector, planner, or runner files", () => {
  const productionFiles = [
    "lib/capability-registry.ts",
    "lib/connectors/registry.ts",
    "lib/workflow-planner.ts",
    "services/connector-runner/src/runner.mjs",
  ];
  for (const file of productionFiles) {
    const source = readFileSync(join(REPOSITORY_ROOT, file), "utf8");
    assert.equal(source.includes(HUBSPOT_GET_CONTACT_CAPABILITY), false, file);
    assert.equal(source.includes(HUBSPOT_PIECE_PACKAGE), false, file);
  }
});
