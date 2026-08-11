import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const CREDENTIAL_ALGORITHM = "aes-256-gcm" as const;
export const CREDENTIAL_ENCRYPTION_VERSION = 1 as const;

export type CredentialContext = {
  userId: string;
  workflowId: string;
  connectorId: string;
  credentialKey: string;
};

export type EncryptedCredential = {
  ciphertext: string;
  nonce: string;
  authTag: string;
  algorithm: typeof CREDENTIAL_ALGORITHM;
  encryptionVersion: typeof CREDENTIAL_ENCRYPTION_VERSION;
};

function parseMasterKey(encodedKey = process.env.FLOWMIND_CREDENTIAL_MASTER_KEY): Buffer {
  if (!encodedKey) throw new Error("Credential encryption is not configured.");

  // One representation is accepted: canonical padded standard Base64 for
  // exactly 32 bytes. Buffer.from(..., "base64") is deliberately not used
  // until syntax has been checked because its decoder ignores some junk.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) {
    throw new Error(
      "Credential encryption key must be canonical padded Base64 for exactly 32 bytes.",
    );
  }
  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32 || key.toString("base64") !== encodedKey) {
    throw new Error(
      "Credential encryption key must be canonical padded Base64 for exactly 32 bytes.",
    );
  }
  return key;
}

function additionalData(context: CredentialContext): Buffer {
  return Buffer.from(
    [
      `v${CREDENTIAL_ENCRYPTION_VERSION}`,
      context.userId,
      context.workflowId,
      context.connectorId,
      context.credentialKey,
    ].join(":"),
    "utf8",
  );
}

export function encryptCredential(
  plaintext: string,
  context: CredentialContext,
  encodedKey?: string,
): EncryptedCredential {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(CREDENTIAL_ALGORITHM, parseMasterKey(encodedKey), nonce);
  cipher.setAAD(additionalData(context));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    algorithm: CREDENTIAL_ALGORITHM,
    encryptionVersion: CREDENTIAL_ENCRYPTION_VERSION,
  };
}

export function decryptCredential(
  encrypted: EncryptedCredential,
  context: CredentialContext,
  encodedKey?: string,
): string {
  if (
    encrypted.algorithm !== CREDENTIAL_ALGORITHM ||
    encrypted.encryptionVersion !== CREDENTIAL_ENCRYPTION_VERSION
  ) {
    throw new Error("Unsupported credential encryption version.");
  }
  const decipher = createDecipheriv(
    CREDENTIAL_ALGORITHM,
    parseMasterKey(encodedKey),
    Buffer.from(encrypted.nonce, "base64"),
  );
  decipher.setAAD(additionalData(context));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
