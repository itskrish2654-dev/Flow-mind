import "@/lib/server-only-runtime";

import {
  isD2OperatorAuthorized,
  type D2OperatorEnvironment,
} from "@/lib/operations/d2-operator-auth";

const MAX_PAT_BYTES = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AIRTABLE_PAT = /^pat[A-Za-z0-9._-]{20,509}$/;

type ConnectionMetadata = {
  id: string;
  user_id: string;
  connector_id: "airtable";
  provider_family: "airtable";
  external_account_id: string;
  external_account_label: string;
  auth_type: "api_key";
  status: "connected";
  granted_scopes: ["data.records:write"];
  safe_metadata: { internalAcceptance: "d2" };
};

type AirtableProvisionDependencies = {
  findConnection(connectionId: string): Promise<{ id: string } | null>;
  insertConnection(metadata: ConnectionMetadata): Promise<void>;
  storeSecret(input: {
    userId: string;
    connectionId: string;
    credentialKey: "api_key";
    credentialType: "api_key";
    plaintext: string;
  }): Promise<void>;
  cleanupConnection(input: {
    userId: string;
    connectionId: string;
    externalAccountId: string;
  }): Promise<void>;
};

type ProvisionOptions = {
  environment?: D2OperatorEnvironment;
  dependencies?: AirtableProvisionDependencies;
};

const defaultDependencies: AirtableProvisionDependencies = {
  async findConnection(connectionId) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data, error } = await createAdminClient()
      .from("connector_connections")
      .select("id")
      .eq("id", connectionId)
      .maybeSingle();
    if (error) throw new Error("Connection inventory is unavailable.");
    return data;
  },
  async insertConnection(metadata) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { error } = await createAdminClient().from("connector_connections").insert(metadata);
    if (error) throw new Error("Connection could not be provisioned.");
  },
  async storeSecret(input) {
    const { storeConnectionSecret } = await import("@/lib/connectors/connection-vault");
    await storeConnectionSecret(input);
  },
  async cleanupConnection({ userId, connectionId, externalAccountId }) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const { error } = await admin
      .from("connector_connections")
      .delete()
      .eq("id", connectionId)
      .eq("user_id", userId)
      .eq("connector_id", "airtable")
      .eq("external_account_id", externalAccountId);
    if (!error) return;
    await admin
      .from("connector_connections")
      .update({ status: "revoked", granted_scopes: [], updated_at: new Date().toISOString() })
      .eq("id", connectionId)
      .eq("user_id", userId)
      .eq("connector_id", "airtable")
      .eq("external_account_id", externalAccountId);
  },
};

async function readBoundedPat(request: Request): Promise<Buffer | null> {
  const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0].trim();
  if (contentType !== "application/octet-stream" && contentType !== "text/plain") return null;
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_PAT_BYTES) {
    return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PAT_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(value));
      value.fill(0);
    }
    if (size < 1) return null;
    return Buffer.concat(chunks, size);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

export function isAirtableProvisionAuthorized(
  request: Request,
  environment: D2OperatorEnvironment = process.env,
): boolean {
  return isD2OperatorAuthorized({
    request,
    environment,
    enabledName: "D2_AIRTABLE_PROVISION_ENABLED",
    secretName: "D2_AIRTABLE_PROVISION_SECRET",
  });
}

export async function provisionAirtableConnection(
  credential: Buffer,
  options: ProvisionOptions = {},
): Promise<{ ok: true; connectionId: string }> {
  const environment = options.environment ?? process.env;
  const dependencies = options.dependencies ?? defaultDependencies;
  const ownerId = environment.D2_AIRTABLE_ACCEPTANCE_OWNER_ID ?? "";
  const connectionId = environment.D2_AIRTABLE_ACCEPTANCE_CONNECTION_ID ?? "";
  const externalAccountId = `d2-airtable:${connectionId}`;
  let created = false;
  try {
    if (!UUID.test(ownerId) || !UUID.test(connectionId)) {
      throw new Error("D2 provisioning configuration is unavailable.");
    }
    // The existing vault API accepts a string. This immutable transient copy
    // cannot be zeroized, so it is kept within this call and never persisted or logged.
    const plaintext = new TextDecoder("utf-8", { fatal: true }).decode(credential);
    if (!AIRTABLE_PAT.test(plaintext)) throw new Error("Invalid Airtable credential.");
    if (await dependencies.findConnection(connectionId)) {
      throw new Error("D2 connection already exists.");
    }
    await dependencies.insertConnection({
      id: connectionId,
      user_id: ownerId,
      connector_id: "airtable",
      provider_family: "airtable",
      external_account_id: externalAccountId,
      external_account_label: "D2 controlled acceptance",
      auth_type: "api_key",
      status: "connected",
      granted_scopes: ["data.records:write"],
      safe_metadata: { internalAcceptance: "d2" },
    });
    created = true;

    await dependencies.storeSecret({
      userId: ownerId,
      connectionId,
      credentialKey: "api_key",
      credentialType: "api_key",
      plaintext,
    });
    return { ok: true, connectionId };
  } catch (error) {
    if (created) {
      await dependencies.cleanupConnection({ userId: ownerId, connectionId, externalAccountId })
        .catch(() => undefined);
    }
    throw error;
  } finally {
    credential.fill(0);
  }
}

export async function handleAirtableProvisionPost(
  request: Request,
  options: ProvisionOptions = {},
): Promise<Response> {
  const environment = options.environment ?? process.env;
  if (!isAirtableProvisionAuthorized(request, environment)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (new URL(request.url).search) {
    return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
  const credential = await readBoundedPat(request);
  if (!credential) {
    return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
  try {
    const result = await provisionAirtableConnection(credential, { ...options, environment });
    return Response.json(result, { status: 200 });
  } catch {
    return Response.json({ ok: false, error: "Provisioning failed" }, { status: 409 });
  } finally {
    credential.fill(0);
  }
}
