import { createRequire } from "node:module";

export const HUBSPOT_PIECE_PACKAGE = "@activepieces/piece-hubspot" as const;
export const HUBSPOT_PIECE_VERSION = "0.8.10" as const;
export const HUBSPOT_GET_CONTACT_CAPABILITY = "hubspot.get_contact@1" as const;
export const HUBSPOT_GET_CONTACT_ACTION = "get-contact" as const;

const MAX_CONTACT_ID_LENGTH = 100;
const MAX_PROPERTY_COUNT = 25;
const MAX_PROPERTY_NAME_LENGTH = 100;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

type UnknownRecord = Record<string, unknown>;

type ActivepiecesAction = {
  name?: unknown;
  classification?: unknown;
  run?: (context: {
    auth: { access_token: string };
    propsValue: {
      contactId: string;
      additionalPropertiesToRetrieve: string[];
    };
  }) => Promise<unknown>;
};

type ActivepiecesPiece = {
  actions?: () => Record<string, ActivepiecesAction>;
};

export type HubSpotGetContactProps = {
  contactId: string;
  additionalPropertiesToRetrieve?: string[];
};

export type NormalizedHubSpotContact = {
  acknowledged: true;
  output: {
    contactId: string;
    properties: Record<string, string | null>;
    createdAt?: string;
    updatedAt?: string;
    archived: boolean;
  };
};

export type PieceExecutionErrorCode =
  | "ACTION_NOT_ALLOWED"
  | "INVALID_INPUT"
  | "INVALID_CREDENTIAL"
  | "PROVIDER_AUTHENTICATION_FAILED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "MALFORMED_PROVIDER_RESPONSE"
  | "PIECE_EXECUTION_FAILED";

export class PieceExecutionError extends Error {
  constructor(
    readonly code: PieceExecutionErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PieceExecutionError";
  }
}

const require = createRequire(import.meta.url);

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function boundedText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

function validateProps(input: HubSpotGetContactProps): Required<HubSpotGetContactProps> {
  const contactId = boundedText(input.contactId, MAX_CONTACT_ID_LENGTH);
  if (!contactId || !/^[A-Za-z0-9_-]+$/.test(contactId)) {
    throw new PieceExecutionError("INVALID_INPUT", "Choose a valid HubSpot contact ID.", false);
  }

  const properties = input.additionalPropertiesToRetrieve ?? [];
  if (!Array.isArray(properties) || properties.length > MAX_PROPERTY_COUNT) {
    throw new PieceExecutionError("INVALID_INPUT", "Too many HubSpot properties were requested.", false);
  }
  const normalizedProperties = properties.map((property) => {
    const value = boundedText(property, MAX_PROPERTY_NAME_LENGTH);
    if (!value || !/^[A-Za-z0-9_]+$/.test(value)) {
      throw new PieceExecutionError("INVALID_INPUT", "A HubSpot property name is invalid.", false);
    }
    return value;
  });

  return { contactId, additionalPropertiesToRetrieve: [...new Set(normalizedProperties)] };
}

function nestedStatus(error: unknown): number | null {
  const top = record(error);
  const response = record(top?.response);
  const body = record(top?.body);
  for (const candidate of [top?.status, top?.statusCode, top?.code, response?.status, body?.statusCode]) {
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
  }
  return null;
}

function retryAfterMs(error: unknown): number | undefined {
  const top = record(error);
  const headerRecord = record(record(top?.response)?.headers) ?? record(top?.headers);
  const raw = headerRecord?.["retry-after"];
  const seconds = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1_000, 60_000) : undefined;
}

function normalizePieceError(error: unknown): PieceExecutionError {
  if (error instanceof PieceExecutionError) return error;
  const status = nestedStatus(error);
  if (status === 401) {
    return new PieceExecutionError(
      "PROVIDER_AUTHENTICATION_FAILED",
      "HubSpot rejected the connection.",
      false,
    );
  }
  if (status === 403) {
    return new PieceExecutionError(
      "PROVIDER_AUTHENTICATION_FAILED",
      "HubSpot did not authorize this operation.",
      false,
    );
  }
  if (status === 429) {
    return new PieceExecutionError(
      "PROVIDER_RATE_LIMITED",
      "HubSpot temporarily rate limited the request.",
      true,
      retryAfterMs(error),
    );
  }
  if (status !== null && status >= 500) {
    return new PieceExecutionError(
      "PROVIDER_UNAVAILABLE",
      "HubSpot is temporarily unavailable.",
      true,
    );
  }
  return new PieceExecutionError(
    "PIECE_EXECUTION_FAILED",
    "The HubSpot piece failed without a safe provider acknowledgement.",
    false,
  );
}

function normalizeContact(value: unknown): NormalizedHubSpotContact {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new PieceExecutionError(
      "MALFORMED_PROVIDER_RESPONSE",
      "HubSpot returned an unreadable response.",
      false,
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESPONSE_BYTES) {
    throw new PieceExecutionError(
      "MALFORMED_PROVIDER_RESPONSE",
      "HubSpot returned a response that was too large.",
      false,
    );
  }

  const contact = record(value);
  const contactId = boundedText(contact?.id, MAX_CONTACT_ID_LENGTH);
  const rawProperties = record(contact?.properties);
  if (!contactId || !rawProperties) {
    throw new PieceExecutionError(
      "MALFORMED_PROVIDER_RESPONSE",
      "HubSpot returned a malformed contact.",
      false,
    );
  }

  const properties: Record<string, string | null> = {};
  for (const [key, propertyValue] of Object.entries(rawProperties)) {
    if (!boundedText(key, MAX_PROPERTY_NAME_LENGTH)) continue;
    if (propertyValue === null || typeof propertyValue === "string") {
      properties[key] = propertyValue;
    }
  }

  return {
    acknowledged: true,
    output: {
      contactId,
      properties,
      ...(boundedText(contact?.createdAt, 100) ? { createdAt: String(contact?.createdAt) } : {}),
      ...(boundedText(contact?.updatedAt, 100) ? { updatedAt: String(contact?.updatedAt) } : {}),
      archived: contact?.archived === true,
    },
  };
}

export function loadPinnedHubSpotAction(): ActivepiecesAction {
  const loaded = require(HUBSPOT_PIECE_PACKAGE) as { hubspot?: ActivepiecesPiece };
  const actions = loaded.hubspot?.actions?.();
  const action = actions?.[HUBSPOT_GET_CONTACT_ACTION];
  if (
    !action ||
    action.name !== HUBSPOT_GET_CONTACT_ACTION ||
    action.classification !== "READ" ||
    typeof action.run !== "function"
  ) {
    throw new PieceExecutionError(
      "ACTION_NOT_ALLOWED",
      "The pinned HubSpot read action is unavailable.",
      false,
    );
  }
  return action;
}

export function resolveExperimentCapability(capability: string) {
  if (capability !== HUBSPOT_GET_CONTACT_CAPABILITY) {
    throw new PieceExecutionError("ACTION_NOT_ALLOWED", "This experimental action is not allowed.", false);
  }
  return {
    packageName: HUBSPOT_PIECE_PACKAGE,
    packageVersion: HUBSPOT_PIECE_VERSION,
    actionName: HUBSPOT_GET_CONTACT_ACTION,
  } as const;
}

export async function executePinnedHubSpotGetContact(input: {
  capability: string;
  props: HubSpotGetContactProps;
  credential: Buffer;
  timeoutMs?: number;
}): Promise<NormalizedHubSpotContact> {
  resolveExperimentCapability(input.capability);
  const props = validateProps(input.props);
  if (!Buffer.isBuffer(input.credential) || input.credential.length < 1 || input.credential.length > 16_384) {
    throw new PieceExecutionError("INVALID_CREDENTIAL", "The HubSpot credential is unavailable.", false);
  }

  const action = loadPinnedHubSpotAction();
  const credential = input.credential.toString("utf8");
  const timeoutMs = Math.max(10, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 30_000));
  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      action.run!({
        auth: { access_token: credential },
        propsValue: props,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new PieceExecutionError("PROVIDER_TIMEOUT", "HubSpot timed out.", true)),
          timeoutMs,
        );
      }),
    ]);
    return normalizeContact(result);
  } catch (error) {
    throw normalizePieceError(error);
  } finally {
    if (timeout) clearTimeout(timeout);
    input.credential.fill(0);
  }
}
