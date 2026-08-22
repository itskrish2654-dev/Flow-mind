export const AIRTABLE_CREATE_RECORD_CAPABILITY = "airtable.create_record";
export const AIRTABLE_CREATE_RECORD_VERSION = 1;

const AIRTABLE_API_ORIGIN = "https://api.airtable.com";
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_FIELDS = 100;
const MAX_FIELD_KEY_LENGTH = 100;
const MAX_VALUE_DEPTH = 8;
const MAX_COLLECTION_ITEMS = 100;
const MAX_STRING_LENGTH = 10_000;
const BASE_ID = /^app[A-Za-z0-9]{14}$/;
const TABLE_ID = /^tbl[A-Za-z0-9]{14}$/;
const RECORD_ID = /^rec[A-Za-z0-9]{14}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function validateJsonValue(value, depth, fail) {
  if (depth > MAX_VALUE_DEPTH) fail("DELEGATED_EXECUTION_FAILED", false);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) fail("DELEGATED_EXECUTION_FAILED", false);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("DELEGATED_EXECUTION_FAILED", false);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_ITEMS) fail("DELEGATED_EXECUTION_FAILED", false);
    for (const item of value) validateJsonValue(item, depth + 1, fail);
    return;
  }
  if (!isRecord(value) || Object.keys(value).length > MAX_COLLECTION_ITEMS) {
    fail("DELEGATED_EXECUTION_FAILED", false);
  }
  for (const [key, nested] of Object.entries(value)) {
    if (!key || key.length > MAX_FIELD_KEY_LENGTH || FORBIDDEN_KEYS.has(key)) {
      fail("DELEGATED_EXECUTION_FAILED", false);
    }
    validateJsonValue(nested, depth + 1, fail);
  }
}

function validateInput(input, fail) {
  if (!isRecord(input) || !hasExactKeys(input, ["baseId", "tableId", "fields"])) {
    fail("DELEGATED_EXECUTION_FAILED", false);
  }
  if (!BASE_ID.test(input.baseId) || !TABLE_ID.test(input.tableId) || !isRecord(input.fields)) {
    fail("DELEGATED_EXECUTION_FAILED", false);
  }
  const entries = Object.entries(input.fields);
  if (entries.length < 1 || entries.length > MAX_FIELDS) {
    fail("DELEGATED_EXECUTION_FAILED", false);
  }
  for (const [key, value] of entries) {
    if (!key || key.length > MAX_FIELD_KEY_LENGTH || FORBIDDEN_KEYS.has(key)) {
      fail("DELEGATED_EXECUTION_FAILED", false);
    }
    validateJsonValue(value, 1, fail);
  }
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_INPUT_BYTES) {
    fail("DELEGATED_EXECUTION_FAILED", false);
  }
  return input;
}

async function readBoundedBody(response, fail) {
  if (!response.body) fail("DELEGATED_BAD_RESPONSE", false);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      fail("DELEGATED_BAD_RESPONSE", false);
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function providerFailure(status, fail) {
  if (status === 401 || status === 403) fail("DELEGATED_AUTH_FAILED", false);
  if (status === 429) fail("DELEGATED_RATE_LIMITED", true);
  if (status >= 500) fail("DELEGATED_UNAVAILABLE", true);
  fail("DELEGATED_EXECUTION_FAILED", false);
}

export function createAirtableCreateRecordAdapter({ fail }) {
  return {
    async execute({ input, credential, signal, fetchImplementation }) {
      const validated = validateInput(input, fail);
      const url = new URL(
        `/v0/${encodeURIComponent(validated.baseId)}/${encodeURIComponent(validated.tableId)}`,
        AIRTABLE_API_ORIGIN,
      );
      let response;
      try {
        response = await fetchImplementation(url, {
          method: "POST",
          redirect: "manual",
          signal,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential.toString("utf8")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ records: [{ fields: validated.fields }] }),
        });
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          fail("DELEGATED_TIMEOUT", true);
        }
        // A network failure after dispatch has an ambiguous create outcome. Do not
        // label it retryable because Airtable create-record has no idempotency key.
        fail("DELEGATED_EXECUTION_FAILED", false);
      }

      if (response.status >= 300 && response.status < 400) {
        fail("DELEGATED_BAD_RESPONSE", false);
      }
      const rawBody = await readBoundedBody(response, fail);
      if (!response.ok) providerFailure(response.status, fail);
      if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
        fail("DELEGATED_BAD_RESPONSE", false);
      }
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        fail("DELEGATED_BAD_RESPONSE", false);
      }
      const recordId = isRecord(parsed) && Array.isArray(parsed.records) && parsed.records.length === 1 &&
        isRecord(parsed.records[0]) ? parsed.records[0].id : null;
      if (typeof recordId !== "string" || !RECORD_ID.test(recordId)) {
        fail("DELEGATED_BAD_RESPONSE", false);
      }
      return { recordId };
    },
  };
}
