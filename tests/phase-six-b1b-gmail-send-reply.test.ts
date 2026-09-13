import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assessCapability, CAPABILITY_REGISTRY } from "../lib/capability-registry";
import { ConnectorError, classifyConnectorHttpFailure } from "../lib/connectors/errors";
import {
  executeGmailReplyToEmail,
  executeGmailSendEmail,
  type GmailActionDependencies,
} from "../lib/connectors/google/gmail-action-core";
import {
  buildRawGmailMessage,
  gmailMessageIdForIdempotencyKey,
  MAX_GMAIL_BODY_BYTES,
  MAX_GMAIL_RECIPIENTS,
} from "../lib/connectors/google/gmail-message";
import type { ConnectorActionContext, ConnectorActionResult } from "../lib/connectors/types";
import { classifyExecutionError } from "../lib/execution-reliability";

const CONTEXT: ConnectorActionContext = {
  userId: "user-a",
  workflowId: "workflow-a",
  executionId: "execution-a",
  stepId: "gmail-step",
  connectionId: "connection-a",
  idempotencyKey: "execution-a:gmail-step",
};

const SOURCE_MESSAGE = {
  threadId: "thread_123",
  payload: {
    headers: [
      { name: "Message-ID", value: "<original@example.com>" },
      { name: "References", value: "<earlier@example.com>" },
      { name: "Subject", value: "Candidate update" },
      { name: "From", value: "Candidate <candidate@example.com>" },
    ],
  },
};

type HarnessOptions = {
  read?: GmailActionDependencies["readMessage"];
  send?: GmailActionDependencies["sendMessage"];
  build?: GmailActionDependencies["buildMessage"];
};

function harness(options: HarnessOptions = {}) {
  const counts = { reads: 0, sends: 0 };
  const dependencies: GmailActionDependencies = {
    ...(options.build ? { buildMessage: options.build } : {}),
    readMessage: options.read ?? (async ({ onDispatch }) => {
      onDispatch();
      counts.reads += 1;
      return SOURCE_MESSAGE;
    }),
    sendMessage: options.send ?? (async ({ threadId, onDispatch }) => {
      onDispatch();
      counts.sends += 1;
      return { id: "message_123", threadId: threadId ?? "thread_456" };
    }),
  };
  return { dependencies, counts };
}

function assertDeterministicFailure(result: ConnectorActionResult) {
  assert.equal(result.status, "failed");
  assert.equal(result.acknowledged, false);
  assert.equal(result.externallyDelivered, false);
  assert.notEqual(result.error?.category, "ambiguous_acknowledgement");
  assert.equal(result.metadata.external_result_ambiguous, false);
  assert.equal(result.metadata.provider_may_have_acted, false);
}

function validSendInput(overrides: Record<string, unknown> = {}) {
  return {
    to: "recipient@example.com",
    subject: "Candidate update",
    body: "The candidate interview is confirmed.",
    ...overrides,
  };
}

function validReplyInput(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "message_123",
    threadId: "thread_123",
    body: "Thank you for the update.",
    ...overrides,
  };
}

test("6B.1B-1 missing and malformed recipients fail before Gmail SEND", async () => {
  for (const to of [undefined, "", "not-an-email", "first@example.com,,second@example.com", { email: "recipient@example.com" }]) {
    const { dependencies, counts } = harness();
    const result = await executeGmailSendEmail(validSendInput({ to }), CONTEXT, dependencies);
    assertDeterministicFailure(result);
    assert.equal(counts.sends, 0);
    assert.equal(result.metadata.side_effect_dispatched, false);
  }
});

test("6B.1B-2 To, Cc, and Bcc enforce recipient count and aggregate header bounds", async () => {
  const boundary = Array.from({ length: MAX_GMAIL_RECIPIENTS }, (_, index) => `person${index}@example.com`);
  const accepted = harness();
  assert.equal((await executeGmailSendEmail(validSendInput({ to: boundary }), CONTEXT, accepted.dependencies)).status, "succeeded");
  assert.equal(accepted.counts.sends, 1);

  const overCount = harness();
  const overCountResult = await executeGmailSendEmail(
    validSendInput({ to: boundary.slice(0, 20), cc: boundary.slice(20, 40), bcc: [...boundary.slice(40), "extra@example.com"] }),
    CONTEXT,
    overCount.dependencies,
  );
  assertDeterministicFailure(overCountResult);
  assert.equal(overCountResult.error?.code, "GMAIL_RECIPIENT_LIMIT");
  assert.equal(overCount.counts.sends, 0);

  const largeAddresses = Array.from({ length: 40 }, (_, index) => `${index}${"a".repeat(200)}@example.com`);
  const overHeaders = harness();
  const overHeadersResult = await executeGmailSendEmail(validSendInput({ to: largeAddresses }), CONTEXT, overHeaders.dependencies);
  assertDeterministicFailure(overHeadersResult);
  assert.equal(overHeadersResult.error?.code, "GMAIL_RECIPIENT_HEADERS_TOO_LARGE");
  assert.equal(overHeaders.counts.sends, 0);
});

test("6B.1B-3 unsafe or oversized headers fail before dispatch and Unicode subjects are encoded safely", async () => {
  for (const subject of ["Candidate update\r\nBcc: attacker@example.com", "a".repeat(513), { value: "Subject" }]) {
    const { dependencies, counts } = harness();
    const result = await executeGmailSendEmail(validSendInput({ subject }), CONTEXT, dependencies);
    assertDeterministicFailure(result);
    assert.equal(counts.sends, 0);
  }
  const raw = Buffer.from(buildRawGmailMessage({
    to: ["recipient@example.com"],
    subject: "Résumé reçu",
    body: "Merci",
    messageId: gmailMessageIdForIdempotencyKey("unicode-test"),
  }), "base64url").toString("utf8");
  assert.match(raw, /Subject: =\?UTF-8\?B\?/);
  assert.doesNotMatch(raw, /\r\nBcc:/);
});

test("6B.1B-4 body and MIME input are bounded before provider dispatch", async () => {
  const nearLimit = harness();
  const accepted = await executeGmailSendEmail(validSendInput({ body: "a".repeat(MAX_GMAIL_BODY_BYTES) }), CONTEXT, nearLimit.dependencies);
  assert.equal(accepted.status, "succeeded");
  assert.equal(nearLimit.counts.sends, 1);

  for (const body of ["a".repeat(MAX_GMAIL_BODY_BYTES + 1), { text: "not accepted" }]) {
    const overLimit = harness();
    const result = await executeGmailSendEmail(validSendInput({ body }), CONTEXT, overLimit.dependencies);
    assertDeterministicFailure(result);
    assert.equal(overLimit.counts.sends, 0);
  }
});

test("6B.1B-5 missing connection and pre-dispatch credential failure are deterministic", async () => {
  const missing = harness();
  const missingResult = await executeGmailSendEmail(validSendInput(), { ...CONTEXT, connectionId: undefined }, missing.dependencies);
  assertDeterministicFailure(missingResult);
  assert.equal(missing.counts.sends, 0);
  assert.equal(missingResult.error?.code, "GMAIL_CONNECTION_REQUIRED");

  const credential = harness({
    send: async () => {
      throw new ConnectorError({ category: "authentication", code: "GOOGLE_RECONNECT_REQUIRED", message: "Reconnect Google to continue.", retryable: false });
    },
  });
  const credentialResult = await executeGmailSendEmail(validSendInput(), CONTEXT, credential.dependencies);
  assertDeterministicFailure(credentialResult);
  assert.equal(credential.counts.sends, 0);
  assert.equal(credentialResult.error?.category, "authentication");
});

test("6B.1B-6 local MIME construction and serialization failures cannot become ambiguous", async () => {
  const mime = harness({ build: () => { throw new Error("raw MIME and secret-token-value"); } });
  const result = await executeGmailSendEmail(validSendInput(), CONTEXT, mime.dependencies);
  assertDeterministicFailure(result);
  assert.equal(mime.counts.sends, 0);
  assert.equal(result.error?.code, "GMAIL_SEND_PREPARATION_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /raw MIME|secret-token-value/);
});

test("6B.1B-7 reply validates local metadata before any provider read or SEND", async () => {
  for (const input of [
    validReplyInput({ messageId: "" }),
    validReplyInput({ threadId: "bad\r\nthread" }),
    validReplyInput({ to: "attacker@example.com\r\nBcc: second@example.com" }),
    validReplyInput({ subject: "Reply\r\nBcc: second@example.com" }),
  ]) {
    const { dependencies, counts } = harness();
    const result = await executeGmailReplyToEmail(input, CONTEXT, dependencies);
    assertDeterministicFailure(result);
    assert.equal(counts.reads, 0);
    assert.equal(counts.sends, 0);
  }
});

test("6B.1B-8 preliminary Gmail GET failure is separate from reply SEND ambiguity", async () => {
  const lookup = harness({
    read: async ({ onDispatch }) => {
      onDispatch();
      lookup.counts.reads += 1;
      throw new ConnectorError(classifyConnectorHttpFailure(503));
    },
  });
  const result = await executeGmailReplyToEmail(validReplyInput(), CONTEXT, lookup.dependencies);
  assertDeterministicFailure(result);
  assert.equal(lookup.counts.reads, 1);
  assert.equal(lookup.counts.sends, 0);
  assert.equal(result.metadata.provider_read_dispatched, true);
  assert.equal(result.metadata.side_effect_dispatched, false);
});

test("6B.1B-9 reply thread mismatch and unsafe provider headers fail before SEND", async () => {
  const mismatch = harness({
    read: async ({ onDispatch }) => {
      onDispatch();
      mismatch.counts.reads += 1;
      return { ...SOURCE_MESSAGE, threadId: "other_thread" };
    },
  });
  const mismatchResult = await executeGmailReplyToEmail(validReplyInput(), CONTEXT, mismatch.dependencies);
  assertDeterministicFailure(mismatchResult);
  assert.equal(mismatch.counts.sends, 0);
  assert.equal(mismatchResult.error?.code, "GMAIL_REPLY_THREAD_MISMATCH");

  const injected = harness({
    read: async ({ onDispatch }) => {
      onDispatch();
      injected.counts.reads += 1;
      return {
        ...SOURCE_MESSAGE,
        payload: { headers: [{ name: "Message-ID", value: "<original@example.com>" }, { name: "From", value: "candidate@example.com\r\nBcc: attacker@example.com" }, { name: "Subject", value: "Safe" }] },
      };
    },
  });
  const injectedResult = await executeGmailReplyToEmail(validReplyInput(), CONTEXT, injected.dependencies);
  assertDeterministicFailure(injectedResult);
  assert.equal(injected.counts.sends, 0);
});

for (const status of [400, 401, 403, 409, 429, 500, 503]) {
  test(`6B.1B-10 conclusive Gmail ${status} is deterministic and never automatically resent`, async () => {
    const provider = harness({
      send: async ({ onDispatch }) => {
        onDispatch();
        provider.counts.sends += 1;
        throw new ConnectorError(classifyConnectorHttpFailure(status));
      },
    });
    const result = await executeGmailSendEmail(validSendInput(), CONTEXT, provider.dependencies);
    assertDeterministicFailure(result);
    assert.equal(provider.counts.sends, 1);
    assert.equal(result.metadata.side_effect_dispatched, true);
    assert.equal(result.error?.retryable, false);
  });
}

test("6B.1B-11 a transport failure before SEND dispatch is not ambiguous", async () => {
  const transport = harness({ send: async () => { throw new Error("network unavailable before dispatch"); } });
  const result = await executeGmailSendEmail(validSendInput(), CONTEXT, transport.dependencies);
  assertDeterministicFailure(result);
  assert.equal(transport.counts.sends, 0);
  assert.equal(result.metadata.side_effect_dispatched, false);
});

test("6B.1B-12 transport loss and timeout after SEND dispatch are ambiguous and non-retryable", async () => {
  for (const failure of [new Error("connection lost"), new DOMException("timed out", "AbortError")]) {
    const transport = harness({
      send: async ({ onDispatch }) => {
        onDispatch();
        transport.counts.sends += 1;
        throw failure;
      },
    });
    const result = await executeGmailSendEmail(validSendInput(), CONTEXT, transport.dependencies);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.error?.category, "ambiguous_acknowledgement");
    assert.equal(result.error?.retryable, false);
    assert.equal(result.metadata.external_result_ambiguous, true);
    assert.equal(result.metadata.provider_may_have_acted, true);
    assert.equal(transport.counts.sends, 1);
    assert.equal(
      classifyExecutionError(new ConnectorError(result.error!)).category,
      "ambiguous_external_result",
    );
  }
});

test("6B.1B-13 send succeeds only after a bounded Gmail acknowledgement", async () => {
  const provider = harness();
  const result = await executeGmailSendEmail(validSendInput(), CONTEXT, provider.dependencies);
  assert.equal(result.status, "succeeded");
  assert.equal(result.acknowledged, true);
  assert.equal(result.externallyDelivered, true);
  assert.deepEqual(result.output, { messageId: "message_123", threadId: "thread_456" });
  assert.equal(provider.counts.sends, 1);

  const missingAcknowledgement = harness({
    send: async ({ onDispatch }) => {
      onDispatch();
      missingAcknowledgement.counts.sends += 1;
      return {};
    },
  });
  const unknown = await executeGmailSendEmail(validSendInput(), CONTEXT, missingAcknowledgement.dependencies);
  assert.equal(unknown.status, "ambiguous");
  assert.equal(unknown.acknowledged, false);
});

test("6B.1B-14 reply success binds the provider acknowledgement to the requested thread", async () => {
  let sentRaw = "";
  const provider = harness({
    send: async ({ raw, threadId, onDispatch }) => {
      onDispatch();
      provider.counts.sends += 1;
      sentRaw = Buffer.from(raw, "base64url").toString("utf8");
      return { id: "reply_123", threadId };
    },
  });
  const result = await executeGmailReplyToEmail(validReplyInput(), CONTEXT, provider.dependencies);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.output, { messageId: "reply_123", threadId: "thread_123" });
  assert.equal(provider.counts.reads, 1);
  assert.equal(provider.counts.sends, 1);
  assert.match(sentRaw, /To: candidate@example\.com/);
  assert.match(sentRaw, /In-Reply-To: <original@example\.com>/);
  assert.match(sentRaw, /References: <earlier@example\.com> <original@example\.com>/);

  const wrongThread = harness({
    send: async ({ onDispatch }) => {
      onDispatch();
      wrongThread.counts.sends += 1;
      return { id: "reply_123", threadId: "wrong_thread" };
    },
  });
  const unknown = await executeGmailReplyToEmail(validReplyInput(), CONTEXT, wrongThread.dependencies);
  assert.equal(unknown.status, "ambiguous");
  assert.equal(unknown.acknowledged, false);
});

test("6B.1B-15 Message-ID is deterministic, valid, distinct by key, and reveals no key material", () => {
  const first = gmailMessageIdForIdempotencyKey("execution-a:step-a:private-marker");
  const rebuilt = gmailMessageIdForIdempotencyKey("execution-a:step-a:private-marker");
  const different = gmailMessageIdForIdempotencyKey("execution-b:step-a:private-marker");
  assert.equal(first, rebuilt);
  assert.notEqual(first, different);
  assert.match(first, /^<[a-f0-9]{64}@crazy-loops\.com>$/);
  assert.doesNotMatch(first, /execution|private-marker/);
});

test("6B.1B-16 returned errors contain neither provider details, credentials, nor raw MIME", async () => {
  const secret = "ya29.disposable-secret-marker";
  const rawMarker = "VGhpcyBpcyBhIHJhdyBNSU1FIG1hcmtlcg";
  const provider = harness({
    send: async ({ onDispatch }) => {
      onDispatch();
      provider.counts.sends += 1;
      throw new Error(`${secret} Authorization: Bearer ${secret} ${rawMarker}`);
    },
  });
  const result = await executeGmailSendEmail(validSendInput(), CONTEXT, provider.dependencies);
  const serialized = JSON.stringify(result);
  assert.equal(result.status, "ambiguous");
  assert.doesNotMatch(serialized, /ya29|Authorization|Bearer|VGhpcy/);
});

test("6B.1B-17 the real Google helper marks dispatch only after token and serialization preparation", async () => {
  const [api, gmail, execution] = await Promise.all([
    readFile("lib/connectors/google/api.ts", "utf8"),
    readFile("lib/connectors/google/gmail.ts", "utf8"),
    readFile("lib/workflow-execution.ts", "utf8"),
  ]);
  const token = api.indexOf("const accessToken = await getGoogleAccessToken(input)");
  const serialization = api.indexOf("serializedBody = JSON.stringify(input.body)");
  const dispatch = api.indexOf("input.onDispatch?.()");
  const network = api.indexOf("response = await fetch(input.url");
  assert.ok(token >= 0 && serialization > token && dispatch > serialization && network > dispatch);
  assert.match(gmail, /dispatchMode: "read"/);
  assert.match(gmail, /dispatchMode: "side_effect"/);
  assert.match(execution, /result\.error\?\.retryable \?\? false,[\s\S]*result\.metadata/);
});

test("6B.1B-18 Gmail remains REVIEWED with onboarding, TEST, and LIVE disabled", () => {
  for (const capabilityId of ["gmail_send_email", "gmail_reply_to_email"] as const) {
    assert.equal(CAPABILITY_REGISTRY[capabilityId].maturity, "REVIEWED");
    assert.equal(CAPABILITY_REGISTRY[capabilityId].onboarding.available, false);
    assert.equal(assessCapability(capabilityId, "test").available, false);
    assert.equal(assessCapability(capabilityId, "production").available, false);
  }
});
