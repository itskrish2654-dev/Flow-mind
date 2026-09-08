import { z } from "zod";

import type { DelegatedErrorCategory } from "@/lib/executors/types";

const MAX_CONTACT_ID_LENGTH = 100;
const MAX_PROPERTY_COUNT = 25;
const MAX_PROPERTY_NAME_LENGTH = 100;
const MAX_OUTPUT_TEXT_LENGTH = 10_000;
const CONTACT_ID = /^[A-Za-z0-9_-]+$/;
const PROPERTY_NAME = /^[A-Za-z0-9_]+$/;

const HubSpotContactIdSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_CONTACT_ID_LENGTH)
  .regex(CONTACT_ID);

const HubSpotPropertySchema = z.string()
  .trim()
  .min(1)
  .max(MAX_PROPERTY_NAME_LENGTH)
  .regex(PROPERTY_NAME);

const HubSpotGetContactInputSchema = z.object({
  contactId: HubSpotContactIdSchema,
  properties: z.array(HubSpotPropertySchema).min(1).max(MAX_PROPERTY_COUNT),
}).strict().transform((value) => ({
  contactId: value.contactId,
  properties: [...new Set(value.properties)],
}));

const HubSpotGetContactOutputSchema = z.object({
  contactId: HubSpotContactIdSchema,
  properties: z.record(
    HubSpotPropertySchema,
    z.string().max(MAX_OUTPUT_TEXT_LENGTH).nullable(),
  ).refine(
    (value) => Object.keys(value).length <= MAX_PROPERTY_COUNT,
    "HubSpot returned too many contact properties.",
  ),
  createdAt: z.string().min(1).max(100).optional(),
  updatedAt: z.string().min(1).max(100).optional(),
  archived: z.boolean(),
}).strict();

export type HubSpotGetContactOutput = z.infer<typeof HubSpotGetContactOutputSchema>;
export type HubSpotGetContactInput = z.infer<typeof HubSpotGetContactInputSchema>;

function parseProperties(value: string | readonly string[]): string[] {
  const entries = (typeof value === "string" ? value.split(/[\n,]/) : value)
    .map((item) => item.trim())
    .filter(Boolean);
  if (entries.length > MAX_PROPERTY_COUNT) {
    throw new Error(`Choose no more than ${MAX_PROPERTY_COUNT} HubSpot properties.`);
  }
  const properties = z.array(HubSpotPropertySchema).min(1).max(MAX_PROPERTY_COUNT).parse(entries);
  return [...new Set(properties)];
}

export function buildHubSpotGetContactInput(input: {
  contactId: string;
  properties: string | readonly string[];
}): { contactId: string; properties: string[] } {
  const contactId = HubSpotContactIdSchema.parse(input.contactId);
  const properties = parseProperties(input.properties);
  return { contactId, properties };
}

export function parseHubSpotGetContactInput(value: unknown): {
  contactId: string;
  properties: string[];
} {
  return HubSpotGetContactInputSchema.parse(value);
}

export function parseHubSpotGetContactOutput(value: unknown): HubSpotGetContactOutput {
  return HubSpotGetContactOutputSchema.parse(value);
}

export function validateHubSpotGetContactOutputForInput(
  rawOutput: unknown,
  authoritativeInput: unknown,
): HubSpotGetContactOutput {
  const input = parseHubSpotGetContactInput(authoritativeInput);
  const output = parseHubSpotGetContactOutput(rawOutput);
  if (output.contactId !== input.contactId) {
    throw new Error("HubSpot returned a different contact than requested.");
  }
  const requestedProperties = new Set(input.properties);
  if (Object.keys(output.properties).some((property) => !requestedProperties.has(property))) {
    throw new Error("HubSpot returned a property that was not requested.");
  }
  return output;
}

export function hubSpotDelegatedErrorMessage(category: DelegatedErrorCategory): string {
  if (category === "DELEGATED_AUTH_FAILED" || category === "DELEGATED_CAPSULE_REJECTED") {
    return "HubSpot authentication failed. Reconnect this account and try again.";
  }
  if (category === "DELEGATED_RATE_LIMITED") {
    return "HubSpot temporarily rate limited this test. Try again later.";
  }
  if (category === "DELEGATED_TIMEOUT") {
    return "HubSpot did not respond before this test timed out.";
  }
  if (
    category === "DELEGATED_DISABLED" ||
    category === "DELEGATED_CONNECTION_FAILED" ||
    category === "DELEGATED_UNAVAILABLE" ||
    category === "DELEGATED_REPLAY_UNAVAILABLE"
  ) {
    return "The connector service is temporarily unavailable.";
  }
  if (category === "DELEGATED_UNSUPPORTED_CAPABILITY") {
    return "This HubSpot action is not available.";
  }
  if (category === "DELEGATED_REPLAYED") {
    return "This test request was already used. Start a new test.";
  }
  return "HubSpot could not complete this test safely.";
}
