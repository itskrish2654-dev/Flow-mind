import { deepFreeze } from "./deep-freeze.mjs";
import { PieceRuntimeError } from "./errors.mjs";

const MAX_CONTACT_ID_LENGTH = 100;
const MAX_PROPERTY_COUNT = 25;
const MAX_PROPERTY_NAME_LENGTH = 100;
const MAX_OUTPUT_PROPERTIES = 100;
const MAX_OUTPUT_TEXT_LENGTH = 10_000;
const CONTACT_ID = /^[A-Za-z0-9_-]+$/;
const PROPERTY_NAME = /^[A-Za-z0-9_]+$/;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function exactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function boundedText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function mapHubSpotGetContact(input) {
  const value = record(input);
  if (!value || !exactKeys(value, ["contactId"], ["properties"])) {
    throw new PieceRuntimeError("PIECE_INVALID_INPUT");
  }
  const contactId = boundedText(value.contactId, MAX_CONTACT_ID_LENGTH);
  if (!contactId || !CONTACT_ID.test(contactId)) throw new PieceRuntimeError("PIECE_INVALID_INPUT");
  const requested = value.properties ?? [];
  if (!Array.isArray(requested) || requested.length > MAX_PROPERTY_COUNT) {
    throw new PieceRuntimeError("PIECE_INVALID_INPUT");
  }
  const properties = requested.map((property) => {
    const normalized = boundedText(property, MAX_PROPERTY_NAME_LENGTH);
    if (!normalized || !PROPERTY_NAME.test(normalized)) {
      throw new PieceRuntimeError("PIECE_INVALID_INPUT");
    }
    return normalized;
  });
  return deepFreeze({
    contactId,
    additionalPropertiesToRetrieve: [...new Set(properties)],
  });
}

function normalizeHubSpotContact(raw) {
  const contact = record(raw);
  const propertiesRecord = record(contact?.properties);
  const contactId = boundedText(contact?.id, MAX_CONTACT_ID_LENGTH);
  if (!contactId || !CONTACT_ID.test(contactId) || !propertiesRecord) {
    throw new PieceRuntimeError("PIECE_RESPONSE_INVALID");
  }
  const entries = Object.entries(propertiesRecord);
  if (entries.length > MAX_OUTPUT_PROPERTIES) throw new PieceRuntimeError("PIECE_RESPONSE_INVALID");
  const properties = {};
  for (const [name, property] of entries) {
    if (!PROPERTY_NAME.test(name) || name.length > MAX_PROPERTY_NAME_LENGTH) {
      throw new PieceRuntimeError("PIECE_RESPONSE_INVALID");
    }
    if (property !== null && (typeof property !== "string" || property.length > MAX_OUTPUT_TEXT_LENGTH)) {
      throw new PieceRuntimeError("PIECE_RESPONSE_INVALID");
    }
    properties[name] = property;
  }
  const createdAt = boundedText(contact.createdAt, 100);
  const updatedAt = boundedText(contact.updatedAt, 100);
  return deepFreeze({
    contactId,
    properties,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    archived: contact.archived === true,
  });
}

const AUTH_PROJECTORS = Object.freeze({
  oauth2_access_token(credential) {
    return { access_token: credential };
  },
  secret_text(credential) {
    return credential;
  },
});

const INPUT_MAPPERS = Object.freeze({ hubspot_get_contact_v1: mapHubSpotGetContact });
const OUTPUT_NORMALIZERS = Object.freeze({ hubspot_contact_v1: normalizeHubSpotContact });

export function createAdapterRegistry(extensions = {}) {
  const authProjectors = Object.freeze({ ...AUTH_PROJECTORS, ...(extensions.authProjectors ?? {}) });
  const inputMappers = Object.freeze({ ...INPUT_MAPPERS, ...(extensions.inputMappers ?? {}) });
  const outputNormalizers = Object.freeze({ ...OUTPUT_NORMALIZERS, ...(extensions.outputNormalizers ?? {}) });
  return Object.freeze({
    projectAuth(identifier, credential) {
      const projector = authProjectors[identifier];
      if (typeof projector !== "function") throw new PieceRuntimeError("PIECE_ACTION_NOT_ALLOWED");
      return projector(credential);
    },
    mapInput(identifier, input) {
      const mapper = inputMappers[identifier];
      if (typeof mapper !== "function") throw new PieceRuntimeError("PIECE_ACTION_NOT_ALLOWED");
      return mapper(input);
    },
    normalizeOutput(identifier, output) {
      const normalizer = outputNormalizers[identifier];
      if (typeof normalizer !== "function") throw new PieceRuntimeError("PIECE_ACTION_NOT_ALLOWED");
      return normalizer(output);
    },
  });
}

export const REVIEWED_ADAPTERS = createAdapterRegistry();
