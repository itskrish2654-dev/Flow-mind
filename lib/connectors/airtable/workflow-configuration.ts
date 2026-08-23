const AIRTABLE_BASE_ID = /^app[A-Za-z0-9]{14}$/;
const AIRTABLE_TABLE_ID = /^tbl[A-Za-z0-9]{14}$/;
const AIRTABLE_RECORD_ID = /^rec[A-Za-z0-9]{14}$/;
const SOURCE_PATH = /^(?:trigger\.)?[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_MAPPING_BYTES = 32 * 1024;
const MAX_FIELDS = 100;
const MAX_FIELD_NAME_LENGTH = 100;
const MAX_SOURCE_PATH_LENGTH = 200;

export const AIRTABLE_CREATE_RECORD_SCOPE = "data.records:write";

export type AirtableFieldMappings = Record<string, string>;

export class AirtableWorkflowConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirtableWorkflowConfigurationError";
  }
}

function credentialShaped(value: string): boolean {
  return /^(?:bearer\s+|pat[A-Za-z0-9]{14,}|sk[-_][A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{12,}\.)/i.test(value.trim());
}

function sensitivePath(value: string): boolean {
  return value
    .replace(/^trigger\./, "")
    .split(".")
    .some((segment) => /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|credential|password|secret|pat)$/i.test(segment));
}

export function parseAirtableFieldMappings(value: string): AirtableFieldMappings {
  if (!value.trim() || Buffer.byteLength(value, "utf8") > MAX_MAPPING_BYTES) {
    throw new AirtableWorkflowConfigurationError("Add a bounded Airtable field mapping.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AirtableWorkflowConfigurationError("Airtable field mapping must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AirtableWorkflowConfigurationError("Airtable field mapping must be a JSON object.");
  }
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > MAX_FIELDS) {
    throw new AirtableWorkflowConfigurationError("Map between 1 and 100 Airtable fields.");
  }
  const mappings: AirtableFieldMappings = Object.create(null) as AirtableFieldMappings;
  for (const [fieldName, source] of entries) {
    if (
      !fieldName.trim() ||
      fieldName.length > MAX_FIELD_NAME_LENGTH ||
      FORBIDDEN_KEYS.has(fieldName) ||
      credentialShaped(fieldName)
    ) {
      throw new AirtableWorkflowConfigurationError("An Airtable field name is invalid.");
    }
    if (
      typeof source !== "string" ||
      !source ||
      source.length > MAX_SOURCE_PATH_LENGTH ||
      !SOURCE_PATH.test(source) ||
      source.split(".").some((part) => FORBIDDEN_KEYS.has(part)) ||
      credentialShaped(source) ||
      sensitivePath(source)
    ) {
      throw new AirtableWorkflowConfigurationError(
        `Choose a safe workflow value for Airtable field “${fieldName}”.`,
      );
    }
    mappings[fieldName] = source;
  }
  return mappings;
}

export function validateAirtableDestinationIdentifiers(baseId: string, tableId: string) {
  if (!AIRTABLE_BASE_ID.test(baseId)) {
    throw new AirtableWorkflowConfigurationError("Enter a valid Airtable Base ID (app + 14 characters).");
  }
  if (!AIRTABLE_TABLE_ID.test(tableId)) {
    throw new AirtableWorkflowConfigurationError("Enter a valid Airtable Table ID (tbl + 14 characters).");
  }
  return { baseId, tableId };
}

export function isValidAirtableRecordId(value: unknown): value is string {
  return typeof value === "string" && AIRTABLE_RECORD_ID.test(value);
}

function readPath(root: Record<string, unknown>, path: string): unknown {
  const normalized = path.replace(/^trigger\./, "");
  let current: unknown = root;
  for (const segment of normalized.split(".")) {
    if (FORBIDDEN_KEYS.has(segment) || !current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function buildAirtableCreateRecordInput(input: {
  baseId: string;
  tableId: string;
  fieldMappings: string;
  workflowValues: Record<string, unknown>;
}) {
  const ids = validateAirtableDestinationIdentifiers(input.baseId, input.tableId);
  const mappings = parseAirtableFieldMappings(input.fieldMappings);
  const fields: Record<string, unknown> = {};
  for (const [fieldName, source] of Object.entries(mappings)) {
    const value = readPath(input.workflowValues, source);
    if (value === undefined) {
      throw new AirtableWorkflowConfigurationError(
        `Workflow value “${source}” is missing for Airtable field “${fieldName}”.`,
      );
    }
    fields[fieldName] = value;
  }
  const result = { ...ids, fields };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 64 * 1024) {
    throw new AirtableWorkflowConfigurationError("The resolved Airtable record is too large.");
  }
  return result;
}

export function isDeferredCustomerAirtableConnection(input: {
  connector_id?: unknown;
  provider_family?: unknown;
  auth_type?: unknown;
  granted_scopes?: unknown;
  safe_metadata?: unknown;
}) {
  const metadata = input.safe_metadata;
  return input.connector_id === "airtable" &&
    input.provider_family === "airtable" &&
    input.auth_type === "api_key" &&
    Array.isArray(input.granted_scopes) &&
    input.granted_scopes.length === 0 &&
    Boolean(metadata) &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).connectionMode === "customer_api_key" &&
    (metadata as Record<string, unknown>).providerVerification === "deferred";
}

export function isVerifiedCustomerAirtableCreateRecordConnection(input: {
  connector_id?: unknown;
  provider_family?: unknown;
  auth_type?: unknown;
  status?: unknown;
  granted_scopes?: unknown;
  safe_metadata?: unknown;
}) {
  const metadata = input.safe_metadata;
  return input.connector_id === "airtable" &&
    input.provider_family === "airtable" &&
    input.auth_type === "api_key" &&
    input.status === "connected" &&
    Array.isArray(input.granted_scopes) &&
    input.granted_scopes.includes(AIRTABLE_CREATE_RECORD_SCOPE) &&
    Boolean(metadata) &&
    typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).connectionMode === "customer_api_key" &&
    (metadata as Record<string, unknown>).providerVerification === "operation_verified" &&
    (metadata as Record<string, unknown>).verifiedOperation === "airtable.create_record";
}
