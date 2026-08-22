import "@/lib/server-only-runtime";

import { randomUUID } from "node:crypto";

const MAX_AIRTABLE_PAT_BYTES = 512;
const AIRTABLE_PAT_PATTERN = /^pat[A-Za-z0-9._-]{20,509}$/;

type AirtableConnectionMetadata = {
  id: string;
  user_id: string;
  connector_id: "airtable";
  provider_family: "airtable";
  external_account_id: string;
  external_account_label: "Airtable connection";
  auth_type: "api_key";
  status: "connected";
  granted_scopes: [];
  safe_metadata: {
    connectionMode: "customer_api_key";
    providerVerification: "deferred";
  };
};

export type AirtableConnectionResult =
  | {
    ok: true;
    connection: {
      id: string;
      provider: "airtable";
      accountLabel: "Airtable connection";
      verification: "locally_configured";
    };
  }
  | { ok: false; error: "Unauthorized" | "Enter a valid Airtable personal access token." | "An Airtable connection already exists. Disconnect it before connecting another." | "Airtable could not be connected. Please try again." };

export type AirtableCustomerConnectionDependencies = {
  getAuthenticatedUserId(): Promise<string | null>;
  findActiveConnection(userId: string): Promise<{ id: string } | null>;
  insertConnection(metadata: AirtableConnectionMetadata): Promise<"inserted" | "conflict">;
  storeSecret(input: {
    userId: string;
    connectionId: string;
    credentialKey: "api_key";
    credentialType: "api_key";
    plaintext: string;
  }): Promise<void>;
  cleanupConnection(input: { userId: string; connectionId: string }): Promise<void>;
};

const defaultDependencies: AirtableCustomerConnectionDependencies = {
  async getAuthenticatedUserId() {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    return user?.id ?? null;
  },
  async findActiveConnection(userId) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { data, error } = await createAdminClient()
      .from("connector_connections")
      .select("id")
      .eq("user_id", userId)
      .eq("connector_id", "airtable")
      .eq("provider_family", "airtable")
      .neq("status", "revoked")
      .maybeSingle();
    if (error) throw new Error("Connection inventory is unavailable.");
    return data;
  },
  async insertConnection(metadata) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { error } = await createAdminClient().from("connector_connections").insert(metadata);
    if (!error) return "inserted";
    if (error.code === "23505") return "conflict";
    throw new Error("Connection could not be created.");
  },
  async storeSecret(input) {
    const { storeConnectionSecret } = await import("@/lib/connectors/connection-vault");
    await storeConnectionSecret(input);
  },
  async cleanupConnection({ userId, connectionId }) {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const { error: deleteError } = await admin
      .from("connector_connections")
      .delete()
      .eq("id", connectionId)
      .eq("user_id", userId)
      .eq("connector_id", "airtable")
      .eq("provider_family", "airtable");
    if (!deleteError) return;

    const { error: revokeError } = await admin
      .from("connector_connections")
      .update({ status: "revoked", granted_scopes: [], updated_at: new Date().toISOString() })
      .eq("id", connectionId)
      .eq("user_id", userId)
      .eq("connector_id", "airtable")
      .eq("provider_family", "airtable");
    if (revokeError) throw new Error("Connection cleanup failed.");
    await admin
      .from("connector_connection_credentials")
      .delete()
      .eq("connection_id", connectionId)
      .eq("user_id", userId);
  },
};

function validAirtablePat(buffer: Buffer): boolean {
  if (buffer.byteLength < 1 || buffer.byteLength > MAX_AIRTABLE_PAT_BYTES) return false;
  try {
    return AIRTABLE_PAT_PATTERN.test(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch {
    return false;
  }
}

export async function connectCustomerAirtable(
  personalAccessToken: string,
  dependencies: AirtableCustomerConnectionDependencies = defaultDependencies,
): Promise<AirtableConnectionResult> {
  const userId = await dependencies.getAuthenticatedUserId();
  if (!userId) return { ok: false, error: "Unauthorized" };

  const credential = Buffer.from(personalAccessToken, "utf8");
  try {
    if (!validAirtablePat(credential)) {
      return { ok: false, error: "Enter a valid Airtable personal access token." };
    }
    if (await dependencies.findActiveConnection(userId)) {
      return { ok: false, error: "An Airtable connection already exists. Disconnect it before connecting another." };
    }

    const connectionId = randomUUID();
    let inserted: "inserted" | "conflict";
    try {
      inserted = await dependencies.insertConnection({
        id: connectionId,
        user_id: userId,
        connector_id: "airtable",
        provider_family: "airtable",
        external_account_id: `customer-airtable:${connectionId}`,
        external_account_label: "Airtable connection",
        auth_type: "api_key",
        status: "connected",
        granted_scopes: [],
        safe_metadata: {
          connectionMode: "customer_api_key",
          providerVerification: "deferred",
        },
      });
    } catch {
      // An interrupted mutation can have an ambiguous outcome. Cleanup is
      // constrained to this freshly generated owner/connection pair.
      await dependencies.cleanupConnection({ userId, connectionId }).catch(() => undefined);
      return { ok: false, error: "Airtable could not be connected. Please try again." };
    }
    if (inserted === "conflict") {
      return { ok: false, error: "An Airtable connection already exists. Disconnect it before connecting another." };
    }

    try {
      // The shared vault currently accepts a string. Keep this unavoidable,
      // immutable copy inside the narrow storage call and never return or log it.
      const plaintext = new TextDecoder("utf-8", { fatal: true }).decode(credential);
      await dependencies.storeSecret({
        userId,
        connectionId,
        credentialKey: "api_key",
        credentialType: "api_key",
        plaintext,
      });
    } catch {
      await dependencies.cleanupConnection({ userId, connectionId }).catch(() => undefined);
      return { ok: false, error: "Airtable could not be connected. Please try again." };
    }

    return {
      ok: true,
      connection: {
        id: connectionId,
        provider: "airtable",
        accountLabel: "Airtable connection",
        verification: "locally_configured",
      },
    };
  } catch {
    return { ok: false, error: "Airtable could not be connected. Please try again." };
  } finally {
    credential.fill(0);
  }
}
