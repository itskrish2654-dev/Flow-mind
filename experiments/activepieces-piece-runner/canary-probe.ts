import { timingSafeEqual } from "node:crypto";

import nock from "nock";

import {
  HUBSPOT_GET_CONTACT_CAPABILITY,
  PieceExecutionError,
  executePinnedHubSpotGetContact,
} from "./adapter";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

function sameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function main() {
  const canary = await readStdin();
  if (!canary) throw new Error("A credential canary is required over stdin.");

  nock.disableNetConnect();
  let credentialReachedProvider = false;
  const provider = nock("https://api.hubapi.com")
    .get(/\/crm\/v3\/objects\/contacts\/contact-123/)
    .query(true)
    .matchHeader("authorization", (value) => {
      credentialReachedProvider = sameSecret(String(value), `Bearer ${canary}`);
      return credentialReachedProvider;
    })
    .reply(200, {
      id: "contact-123",
      properties: { email: "reader@example.test", firstname: "Casey" },
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:01:00.000Z",
      archived: false,
    });

  let normalizedContactId = "";
  let safeErrorCode = "";
  try {
    const credential = Buffer.from(canary);
    const result = await executePinnedHubSpotGetContact({
      capability: HUBSPOT_GET_CONTACT_CAPABILITY,
      props: { contactId: "contact-123", additionalPropertiesToRetrieve: ["firstname"] },
      credential,
    });
    normalizedContactId = result.output.contactId;
    if (!credential.every((byte) => byte === 0)) throw new Error("Credential buffer was not cleared.");

    nock("https://api.hubapi.com")
      .get(/\/crm\/v3\/objects\/contacts\/contact-401/)
      .query(true)
      .reply(401, { status: "error", message: "Unauthorized" });
    try {
      await executePinnedHubSpotGetContact({
        capability: HUBSPOT_GET_CONTACT_CAPABILITY,
        props: { contactId: "contact-401" },
        credential: Buffer.from(canary),
      });
    } catch (error) {
      safeErrorCode = error instanceof PieceExecutionError ? error.code : "UNSAFE_ERROR";
    }
  } finally {
    const pendingMocks = nock.pendingMocks().length;
    nock.cleanAll();
    nock.enableNetConnect();
    process.stdout.write(
      `${JSON.stringify({
        pieceLoaded: true,
        credentialReachedProvider,
        normalizedContactId,
        safeErrorCode,
        pendingMocks,
        activepiecesServerInvolved: false,
        activepiecesDatabaseInvolved: false,
        activepiecesConnectionInvolved: false,
      })}\n`,
    );
  }
}

void main().catch((error: unknown) => {
  const safeCode = error instanceof PieceExecutionError ? error.code : "CANARY_PROBE_FAILED";
  process.stderr.write(`${safeCode}\n`);
  process.exitCode = 1;
});
