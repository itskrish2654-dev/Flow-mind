import {
  findRequestedUnsupportedCapabilities,
  getCapability,
  type CapabilityDefinition,
  type CapabilityId,
} from "@/lib/capability-registry";
import { parseScheduleLanguage, type ScheduleDefinition } from "@/lib/scheduling";
import type { FormatterConfig, FormatterOperation, FormatterSource } from "@/lib/formatter";
import type { HttpRequestConfig } from "@/lib/schemas/workflow";

export const PLANNING_STATUSES = [
  "READY_TO_COMPILE",
  "NEEDS_CLARIFICATION",
  "UNSUPPORTED",
  "CONFLICTING_REQUIREMENTS",
] as const;

export type PlanningStatus = (typeof PLANNING_STATUSES)[number];

export type PlannedCapability = {
  capabilityId: CapabilityId;
  displayName: string;
  instruction?: string;
  formatter?: FormatterConfig;
  http?: HttpRequestConfig;
};

export type PlannedCondition = {
  capabilityId: "condition.if";
  sourcePath: string;
  operator:
    | "equals"
    | "not_equals"
    | "contains"
    | "not_contains"
    | "exists"
    | "not_exists"
    | "greater_than"
    | "less_than"
    | "is_true"
    | "is_false";
  expectedValue?: string | number | boolean;
  humanLabel: string;
  usesAiClassification: boolean;
};

export type WorkflowPlan = {
  status: PlanningStatus;
  intent: string;
  trigger: PlannedCapability | null;
  transformations: PlannedCapability[];
  destination: PlannedCapability | null;
  otherwiseDestination: PlannedCapability | null;
  condition: PlannedCondition | null;
  schedule: ScheduleDefinition | null;
  missingRequirements: string[];
  contradictions: string[];
  requestedUnsupportedCapabilities: Array<{
    capabilityId: string;
    displayName: string;
  }>;
  message: string;
  clarificationQuestions: string[];
};

function plannedCapability(
  capabilityId: CapabilityId,
  instruction?: string,
): PlannedCapability {
  const capability = getCapability(capabilityId);
  if (!capability) throw new Error(`Unknown CrazyLoops capability: ${capabilityId}`);
  return {
    capabilityId,
    displayName: capability.displayName,
    ...(instruction ? { instruction } : {}),
  };
}

function unsupportedSummary(capabilities: CapabilityDefinition[]) {
  return capabilities.map((capability) => ({
    capabilityId: capability.id,
    displayName: capability.displayName,
  }));
}

function detectContradictions(prompt: string): string[] {
  const contradictions: string[] = [];
  if (
    /\b(automatically|automatic|without asking|immediately)\b/i.test(prompt) &&
    /\b(ask me|approval|approve|review)\b[^.]{0,40}\b(before|first)\b|\b(before|first)\b[^.]{0,40}\b(send|sending|publish|post)\b/i.test(prompt)
  ) {
    contradictions.push(
      "The request asks CrazyLoops to act automatically and also wait for approval before acting.",
    );
  }
  if (/\bnever store\b/i.test(prompt) && /\b(history|previous|store|save|data table)\b/i.test(prompt)) {
    contradictions.push(
      "The request says not to store data but also asks CrazyLoops to retain it.",
    );
  }
  if (/\b(public|anyone)\b/i.test(prompt) && /\b(only me|private to me)\b/i.test(prompt)) {
    contradictions.push(
      "The same input is requested as both public and private-only.",
    );
  }
  return contradictions;
}

function isVaguePrompt(prompt: string): boolean {
  const words = prompt.match(/[a-z0-9]+/gi) ?? [];
  if (words.length <= 3) return true;
  return /^(automate my leads|make something useful|help my business|automation for customers)[.!]?$/i.test(
    prompt.trim(),
  );
}

function detectTransformations(prompt: string): PlannedCapability[] {
  const transformations: PlannedCapability[] = [];
  const add = (instruction: string) =>
    transformations.push(plannedCapability("ai_text_transform", instruction));

  if (/\b(summarize|summarise|summarization|summarisation|summary)\b/i.test(prompt)) {
    add("Summarize the submitted information clearly and accurately.");
  }
  if (/\b(sentiment|classify|categorize|categorise|category)\b/i.test(prompt)) {
    add("Classify the submitted information and explain the classification briefly.");
  }
  if (/\b(qualify|score|prioritize|prioritise|rank)\b/i.test(prompt)) {
    add("Evaluate and prioritize the submitted information using the criteria in the request.");
  }
  if (/\b(extract|identify|find key|pull out)\b/i.test(prompt)) {
    add("Extract the requested facts from the submitted information without inventing values.");
  }
  if (/\b(analyze|analyse|evaluate)\b/i.test(prompt)) {
    add("Analyze the submitted information using the criteria in the request.");
  }
  if (/\b(draft|write|compose|recommend|suggest)\b/i.test(prompt)) {
    add("Draft the requested text using the submitted information and earlier results.");
  }
  if (/\b(translate|rewrite|rephrase|respond|answer)\b/i.test(prompt)) {
    add("Create the requested text response from the submitted information.");
  }

  return transformations;
}

function formatterSource(field: string): FormatterSource {
  const path = normalizeFieldPath(field
    .replace(/[’']s\b/gi, "")
    .replace(/\binstead\b/gi, "")
    .replace(/\b(customer|submitted|input|field|value|the|response)\b/gi, " ")
    .trim());
  return { kind: "trigger", path };
}

function formatterOutputKey(field: string, operation: FormatterOperation): string {
  const base = formatterSource(field).path ?? "value";
  const suffix: Partial<Record<FormatterOperation, string>> = {
    trim: "trimmed", uppercase: "uppercase", lowercase: "lowercase", title_case: "title_case",
    replace: "replaced", split: "parts", join: "joined", prepend: "prepended", append: "appended",
    add: "added", subtract: "subtracted", multiply: "multiplied", divide: "divided", round: "rounded",
    format_date: "formatted", add_duration: "date_added", subtract_duration: "date_subtracted",
    convert_timezone: "converted", default_value: "with_default", first_non_empty: "first_non_empty",
  };
  return `${base}_${suffix[operation] ?? "formatted"}`.slice(0, 80);
}

function formatterCapability(config: FormatterConfig): PlannedCapability {
  return {
    ...plannedCapability("formatter.transform"),
    formatter: config,
  };
}

function detectFormatterTransformations(prompt: string): PlannedCapability[] {
  const found: Array<{ index: number; capability: PlannedCapability }> = [];
  const add = (index: number, operation: FormatterOperation, field: string, extra: Partial<FormatterConfig> = {}) => {
    const source = formatterSource(field);
    found.push({
      index,
      capability: formatterCapability({
        version: 1,
        operation,
        source,
        outputKey: formatterOutputKey(field, operation),
        ...extra,
      }),
    });
  };
  const matchAll = (pattern: RegExp, handler: (match: RegExpExecArray) => void) => {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(prompt)) !== null) handler(match);
  };

  matchAll(/\btrim\s+(?:the\s+)?([a-z][a-z0-9 _'’-]{0,40}?)(?=\s+(?:then|and then|before|after)\b|[.,;]|$)/gi, (match) => add(match.index, "trim", match[1]));
  matchAll(/\bremove\s+(?:the\s+)?spaces\s+around\s+(?:the\s+)?([a-z][a-z0-9 _'’-]{0,40}?)(?=[.,;]|$)/gi, (match) => add(match.index, "trim", match[1]));
  matchAll(/\b(?:make|convert|format)\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)\s+(?:to\s+|into\s+)?title case\b/gi, (match) => add(match.index, "title_case", match[1]));
  matchAll(/\b(?:make|convert)\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)\s+(?:to\s+|into\s+)?(uppercase|upper case|lowercase|lower case)\b/gi, (match) => add(match.index, /upper/i.test(match[2]) ? "uppercase" : "lowercase", match[1]));
  matchAll(/\breplace\s+["']([^"']{1,200})["']\s+with\s+["']([^"']{0,200})["']\s+in\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)(?=[.,;]|$)/gi, (match) => add(match.index, "replace", match[3], { find: match[1], replacement: match[2] }));
  matchAll(/\bsplit\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)\s+(?:by|on)\s+["']([^"']{1,50})["']/gi, (match) => add(match.index, "split", match[1], { separator: match[2] }));
  matchAll(/\bjoin\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)\s+with\s+["']([^"']{0,50})["']/gi, (match) => add(match.index, "join", match[1], { separator: match[2] }));
  matchAll(/\b(prepend|append)\s+["']([^"']{0,200})["']\s+(?:to\s+)?(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)(?=[.,;]|$)/gi, (match) => add(match.index, match[1].toLowerCase() as "prepend" | "append", match[3], { value: match[2] }));
  matchAll(/\bmultiply\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)\s+by\s+(-?\d+(?:\.\d+)?)/gi, (match) => add(match.index, "multiply", match[1], { operand: Number(match[2]) }));
  matchAll(/\bdivide\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)\s+by\s+(-?\d+(?:\.\d+)?)/gi, (match) => add(match.index, "divide", match[1], { operand: Number(match[2]) }));
  matchAll(/\badd\s+(-?\d+(?:\.\d+)?)\s+to\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)(?=[.,;]|$)/gi, (match) => add(match.index, "add", match[2], { operand: Number(match[1]) }));
  matchAll(/\bsubtract\s+(-?\d+(?:\.\d+)?)\s+from\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)(?=[.,;]|$)/gi, (match) => add(match.index, "subtract", match[2], { operand: Number(match[1]) }));
  matchAll(/\bround\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)\s+to\s+(\d{1,2})\s+decimal places?\b/gi, (match) => add(match.index, "round", match[1], { decimalPlaces: Number(match[2]) }));
  matchAll(/\bformat\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)\s+as\s+([YMDHmsT:/._ -]{2,40})(?=[.,;]|$)/gi, (match) => add(match.index, "format_date", match[1], { dateFormat: match[2].trim(), timezone: "UTC" }));
  matchAll(/\bconvert\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)\s+to\s+((?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_+-]+)\b/gi, (match) => add(match.index, "convert_timezone", match[1], { timezone: match[2] }));
  matchAll(/\b(add|subtract)\s+(\d+)\s+(minutes?|hours?|days?)\s+(?:to|from)\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)(?=[.,;]|$)/gi, (match) => add(match.index, match[1].toLowerCase() === "add" ? "add_duration" : "subtract_duration", match[4], { durationAmount: Number(match[2]), durationUnit: match[3].toLowerCase().replace(/s$/, "") + "s" as "minutes" | "hours" | "days" }));
  matchAll(/\bif\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)\s+(?:(?:is\s+)?empty|is\s+missing),?\s+use\s+["']([^"']{0,100})["']/gi, (match) => add(match.index, "default_value", match[1], { value: match[2] }));
  matchAll(/\bif\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,40}?)\s+(?:(?:is\s+)?empty|is\s+missing),?\s+use\s+(Unknown|N\/A|None|true|false|0)\b/gi, (match) => add(match.index, "default_value", match[1], { value: match[2] }));
  matchAll(/\bif\s+(?:the\s+)?([a-z][a-z0-9 _-]{0,30}?)\s+(?:(?:is\s+)?empty|is\s+missing),?\s+use\s+(?:the\s+)?(?!Unknown\b|None\b|true\b|false\b)([a-z][a-z0-9 _-]{0,30}?)(?=\s+instead\b|[.,;]|$)(?:\s+instead)?/gi, (match) => {
    const source = formatterSource(match[1]);
    found.push({ index: match.index, capability: formatterCapability({ version: 1, operation: "first_non_empty", source, sources: [formatterSource(match[2])], outputKey: `${source.path ?? "value"}_or_${formatterSource(match[2]).path ?? "fallback"}`.slice(0, 80) }) });
  });

  return found
    .sort((left, right) => left.index - right.index)
    .filter((item, index, items) => index === items.findIndex((candidate) => candidate.index === item.index && candidate.capability.formatter?.operation === item.capability.formatter?.operation))
    .map((item) => item.capability);
}

function detectsPublicFormTrigger(prompt: string): boolean {
  return /\b(form|submission|submit|survey|intake|feedback|questionnaire|application)\b/i.test(
    prompt,
  );
}

function detectsWebhookTrigger(prompt: string): boolean {
  return /\b(incoming webhook|webhook trigger|when (?:a |the )?webhook|webhook (?:arrives|is received))\b/i.test(prompt);
}

function detectsHttpDestination(prompt: string): boolean {
  return /\b(post (?:json|it|the result)|send (?:it|the result) to (?:an? )?webhook|http request)\b/i.test(prompt);
}

type HttpPlanning = {
  requested: boolean;
  capability: PlannedCapability | null;
  missingUrl: boolean;
  ambiguousMethod: boolean;
  ambiguousAuth: boolean;
};

function planHttpRequest(prompt: string): HttpPlanning {
  if (/\bpost\s+(?:it|the\s+result)\s+to\s+https:\/\//i.test(prompt) && !/\b(?:api|http\s+request)\b/i.test(prompt)) {
    return { requested: false, capability: null, missingUrl: false, ambiguousMethod: false, ambiguousAuth: false };
  }
  const requested = /\b(?:api|endpoint|http\s+request|http\s+(?:get|post|put|patch|delete)|call\s+(?:this|the|an?)\s+api)\b/i.test(prompt)
    || /https:\/\/[^\s)\]]+/i.test(prompt);
  if (!requested) return { requested: false, capability: null, missingUrl: false, ambiguousMethod: false, ambiguousAuth: false };
  const url = prompt.match(/https:\/\/[^\s)\]}>,;]+/i)?.[0]?.replace(/[.!?]+$/, "");
  const explicit = prompt.match(/\b(GET|POST|PUT|PATCH|DELETE)\b/i)?.[1]?.toUpperCase() as HttpRequestConfig["method"] | undefined;
  const ambiguousMethod = !explicit && /\b(update|modify|change)\b/i.test(prompt);
  const method: HttpRequestConfig["method"] | null = explicit
    ?? (/\b(delete|remove)\b/i.test(prompt) ? "DELETE"
      : /\b(send|post|create|submit)\b/i.test(prompt) ? "POST"
      : /\b(get|fetch|retrieve|read|list)\b/i.test(prompt) ? "GET"
      : null);
  const authType: HttpRequestConfig["authType"] = /\bbearer(?:\s+token)?\b/i.test(prompt)
    ? "bearer"
    : /\bbasic\s+auth(?:entication)?\b/i.test(prompt)
      ? "basic"
      : /\bapi\s+key\b[^.]{0,50}\bquery\b|\bquery\b[^.]{0,50}\bapi\s+key\b/i.test(prompt)
        ? "api_key_query"
        : /\bapi\s+key\b/i.test(prompt)
          ? "api_key_header"
          : "none";
  const ambiguousAuth = authType === "none" && /\b(authenticated|authentication|secured?\s+api|with\s+auth)\b/i.test(prompt);
  const authName = prompt.match(/\b(?:header|query(?:\s+parameter)?)\s+(?:named?|name\s+is)\s+["']?([A-Za-z][A-Za-z0-9_-]{0,79})/i)?.[1];
  const authUsername = prompt.match(/\busername\s+(?:is\s+)?["']?([^\s"']{1,100})/i)?.[1];
  if (!url || !method || ambiguousMethod || ambiguousAuth) {
    return { requested: true, capability: null, missingUrl: !url, ambiguousMethod: ambiguousMethod || !method, ambiguousAuth };
  }
  return {
    requested: true,
    capability: {
      ...plannedCapability("http.request"),
      http: {
        version: 2,
        url,
        method,
        authType,
        ...(authName ? { authName } : {}),
        ...(authUsername ? { authUsername } : {}),
        ...(/\bX-Idempotency-Key\b/i.test(prompt) ? { idempotencyHeader: "X-Idempotency-Key" as const }
          : /\bIdempotency-Key\b/i.test(prompt) ? { idempotencyHeader: "Idempotency-Key" as const } : {}),
        timeoutMs: 10_000,
      },
    },
    missingUrl: false,
    ambiguousMethod: false,
    ambiguousAuth: false,
  };
}

function detectsInternalDestination(prompt: string): boolean {
  return /\b(crazyloops|flowmind|internal(?:ly)?|data table|store|save|record|keep)\b/i.test(prompt);
}

function detectsPdfDestination(prompt: string): boolean {
  return /\b(pdf|invoice|proposal|document|downloadable report)\b/i.test(prompt);
}

function normalizeFieldPath(value: string): string {
  return value.trim().toLowerCase().replace(/\b(the|a|an|this)\b/g, " ").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "value";
}

function parseCondition(prompt: string): PlannedCondition | null {
  const firstIf = prompt.search(/\bif\b/i);
  if (
    firstIf >= 0 &&
    /^if\s+(?:the\s+)?[a-z][a-z0-9 _-]{0,40}?\s+(?:(?:is\s+)?empty|is\s+missing),?\s+use\s+(?:["'][^"']{0,100}["']|Unknown\b|N\/A\b|None\b|true\b|false\b|0\b|(?:the\s+)?[a-z][a-z0-9 _-]{0,30}?(?:\s+instead)?)(?=[.,;]|$)/i.test(prompt.slice(firstIf))
  ) {
    // This is a deterministic Formatter fallback, not a conditional branch.
    return null;
  }
  const clause = prompt.match(/\bif\s+(.+?)(?=\b(?:then|otherwise|else|notify|send|post|save|store|add|create|update)\b|[.,]|$)/i)?.[1]?.trim();
  if (!clause) return null;
  const comparison = clause.match(/^(.+?)\s+(does not contain|doesn't contain|does not equal|is not equal to|is greater than|greater than|is less than|less than|contains|equals|is equal to|exists|does not exist|is true|is false|is)\s*(.*)$/i);
  const aiClassification = /\b(looks? like|classif(?:y|ies|ied) as|anything is|request is)\b/i.test(clause)
    && !/\b(amount|price|total|status|priority|email|name|field)\b/i.test(clause);
  if (!comparison) {
    if (!aiClassification) return null;
    const label = clause.replace(/^(?:this|anything|the request)\s+/i, "").trim();
    const expected = label.replace(/^(?:looks? like|is|classif(?:y|ies|ied) as)\s+/i, "").trim();
    return { capabilityId: "condition.if", sourcePath: "ai_result", operator: "contains", expectedValue: expected, humanLabel: `If AI classifies this as ${expected}`, usesAiClassification: true };
  }
  const [, rawField, rawOperator, rawValue] = comparison;
  const operatorText = rawOperator.toLowerCase();
  const operator: PlannedCondition["operator"] = operatorText.includes("does not contain") || operatorText.includes("doesn't contain")
    ? "not_contains"
    : operatorText.includes("contain")
      ? "contains"
      : operatorText.includes("does not equal") || operatorText.includes("not equal")
        ? "not_equals"
        : operatorText.includes("greater")
          ? "greater_than"
          : operatorText.includes("less")
            ? "less_than"
            : operatorText === "exists"
              ? "exists"
              : operatorText === "does not exist"
                ? "not_exists"
                : operatorText === "is true"
                  ? "is_true"
                  : operatorText === "is false"
                    ? "is_false"
                    : "equals";
  const cleanedValue = rawValue.trim().replace(/^['"]|['"]$/g, "").replace(/^\$/, "").replace(/,/g, "");
  const expectedValue = ["exists", "not_exists", "is_true", "is_false"].includes(operator)
    ? undefined
    : /^(?:-?\d+(?:\.\d+)?)$/.test(cleanedValue)
      ? Number(cleanedValue)
      : cleanedValue;
  const field = normalizeFieldPath(rawField);
  return {
    capabilityId: "condition.if",
    sourcePath: field,
    operator,
    ...(expectedValue !== undefined ? { expectedValue } : {}),
    humanLabel: `If ${rawField.trim()} ${rawOperator.toLowerCase()}${rawValue.trim() ? ` ${rawValue.trim()}` : ""}`,
    usesAiClassification: false,
  };
}

function detectDestination(prompt: string, options: { asksForGmail: boolean; asksForSheets: boolean; asksForSlack: boolean; asksForNotion: boolean; asksForWebhook: boolean; triggerPresent: boolean }): PlannedCapability | null {
  const asksForGmail = options.asksForGmail || /\bgmail\b/i.test(prompt);
  const asksForSheets = options.asksForSheets || /\bgoogle sheets?\b|\bsheets?\b/i.test(prompt);
  const asksForSlack = options.asksForSlack || /\bslack\b|#[a-z0-9_-]+/i.test(prompt);
  const asksForNotion = options.asksForNotion || /\bnotion\b/i.test(prompt);
  if (asksForSheets && /\b(add|save|store|update|find|lookup)\b/i.test(prompt)) return plannedCapability(/\bupdate row\b/i.test(prompt) ? "google_sheets_update_row" : /\bfind|lookup\b/i.test(prompt) ? "google_sheets_find_row" : "google_sheets_add_row");
  if (asksForGmail && /\breply\b/i.test(prompt)) return plannedCapability("gmail_reply_to_email");
  if (asksForGmail && /\b(send|email it|mail it)\b/i.test(prompt)) return plannedCapability("gmail_send_email");
  if (asksForSlack && /\b(reply)\b[^.]{0,30}\bthread\b|\bthread\b[^.]{0,30}\breply\b/i.test(prompt)) return plannedCapability("slack_reply_in_thread");
  if (asksForSlack && /\b(send|post|alert|notify)\b/i.test(prompt)) return plannedCapability("slack_send_channel_message");
  if (asksForNotion && /\bupdate\b/i.test(prompt)) return plannedCapability("notion_update_item");
  if (asksForNotion && /\bcreate\b[^.]{0,30}\bpage\b|\bpage\b[^.]{0,30}\bcreate\b/i.test(prompt)) return plannedCapability("notion_create_page");
  if (asksForNotion && /\b(save|add|create|store|notion)\b/i.test(prompt)) return plannedCapability("notion_create_data_source_item");
  if (detectsHttpDestination(prompt) || (options.asksForWebhook && !detectsWebhookTrigger(prompt))) return plannedCapability("generic_http_action");
  if (detectsPdfDestination(prompt)) return plannedCapability("generate_pdf");
  if (detectsInternalDestination(prompt) || options.triggerPresent) return plannedCapability("flowmind_data_store");
  return null;
}

export function deriveGmailSearch(prompt: string): string | null {
  const terms: string[] = [];
  const from = prompt.match(/\bfrom\s+(@[A-Za-z0-9.-]+|[^\s,]+@[^\s,]+)/i)?.[1];
  if (from) terms.push(`from:(${from})`);
  const contains = prompt.match(/\bcontains?\s+["']([^"']{1,100})["']/i)?.[1] ?? prompt.match(/\bcontains?\s+([A-Za-z0-9_-]{2,60})/i)?.[1];
  if (contains) terms.push(`"${contains.replace(/["\\]/g, "")}"`);
  const subject = prompt.match(/\bsubject(?:\s+contains?|\s+is)?\s+["']?([A-Za-z0-9 _-]{2,80})["']?/i)?.[1]?.trim();
  if (subject) terms.push(`subject:("${subject.replace(/["\\]/g, "")}")`);
  return terms.length ? terms.join(" ") : null;
}

export function planWorkflow(prompt: string): WorkflowPlan {
  const normalizedPrompt = prompt.trim();
  const base = {
    intent: normalizedPrompt,
    trigger: null,
    transformations: [] as PlannedCapability[],
    destination: null,
    otherwiseDestination: null,
    condition: null,
    schedule: null,
    missingRequirements: [] as string[],
    contradictions: [] as string[],
    requestedUnsupportedCapabilities: [] as Array<{
      capabilityId: string;
      displayName: string;
    }>,
    clarificationQuestions: [] as string[],
  };

  const contradictions = detectContradictions(normalizedPrompt);
  if (contradictions.length > 0) {
    return {
      ...base,
      status: "CONFLICTING_REQUIREMENTS",
      contradictions,
      message: "These requirements conflict, so CrazyLoops will not invent a compromise.",
      clarificationQuestions: [
        "Should this automation act automatically, or wait for a person to approve it?",
      ],
    };
  }

  const asksForGmail = /\bgmail\b/i.test(normalizedPrompt);
  const asksForSheets = /\bgoogle sheets?\b|\bsheets?\b/i.test(normalizedPrompt);
  const asksForSlack = /\bslack\b|#[a-z0-9_-]+/i.test(normalizedPrompt);
  const asksForNotion = /\bnotion\b/i.test(normalizedPrompt);
  const unsupported = findRequestedUnsupportedCapabilities(normalizedPrompt).filter((capability) => !(asksForGmail && ["email_ingestion", "email_delivery"].includes(capability.id)));
  const asksForUnknownExternalConnection =
    /\b(connect(?:\s+to)?|sync\s+(?:to|with)|post\s+(?:it\s+)?to)\b/i.test(
      normalizedPrompt,
    ) &&
    !/\b(crazyloops|flowmind|pdf|document|webhook|http request|gmail|google sheets?|sheets?|slack|notion)\b/i.test(normalizedPrompt) &&
    unsupported.length === 0;
  if (asksForUnknownExternalConnection) {
    const externalIntegration = getCapability("external_integration");
    if (externalIntegration) unsupported.push(externalIntegration);
  }

  const uniqueUnsupported = Array.from(
    new Map(unsupported.map((capability) => [capability.id, capability])).values(),
  );
  if (uniqueUnsupported.length > 0) {
    const requested = unsupportedSummary(uniqueUnsupported);
    return {
      ...base,
      status: "UNSUPPORTED",
      requestedUnsupportedCapabilities: requested,
      message: requested
        .map(({ displayName }) => `${displayName} is not currently supported.`)
        .join(" "),
    };
  }

  const httpPlanning = planHttpRequest(normalizedPrompt);
  if (httpPlanning.requested && (httpPlanning.missingUrl || httpPlanning.ambiguousMethod || httpPlanning.ambiguousAuth)) {
    const missingRequirements: string[] = [];
    const clarificationQuestions: string[] = [];
    if (httpPlanning.missingUrl) {
      missingRequirements.push("API endpoint");
      clarificationQuestions.push("What API endpoint should CrazyLoops call?");
    }
    if (httpPlanning.ambiguousMethod) {
      missingRequirements.push("HTTP method");
      clarificationQuestions.push(/\b(update|modify|change)\b/i.test(normalizedPrompt)
        ? "Should CrazyLoops update this record with PATCH or replace it completely with PUT?"
        : "Should CrazyLoops create, update, or delete the record?");
    }
    if (httpPlanning.ambiguousAuth) {
      missingRequirements.push("authentication method");
      clarificationQuestions.push("How should CrazyLoops authenticate with this API?");
    }
    return { ...base, status: "NEEDS_CLARIFICATION", missingRequirements, message: "CrazyLoops needs the missing API details before it can build this request.", clarificationQuestions };
  }

  const formatterTransformations = detectFormatterTransformations(normalizedPrompt);
  if (/\bconvert\b[^.]{0,80}\b(?:local time|local timezone)\b/i.test(normalizedPrompt)) {
    return {
      ...base,
      status: "NEEDS_CLARIFICATION",
      transformations: formatterTransformations,
      missingRequirements: ["timezone"],
      message: "CrazyLoops needs an explicit timezone before it can configure this deterministic conversion.",
      clarificationQuestions: ["Which timezone should CrazyLoops use?"],
    };
  }

  const parsedSchedule = parseScheduleLanguage(normalizedPrompt);
  if (parsedSchedule && !parsedSchedule.ok) {
    return {
      ...base,
      status: "NEEDS_CLARIFICATION",
      missingRequirements: ["schedule"],
      message: "CrazyLoops needs one schedule detail before it can build this loop.",
      clarificationQuestions: parsedSchedule.questions,
    };
  }

  if (!normalizedPrompt || (isVaguePrompt(normalizedPrompt) && !parsedSchedule && formatterTransformations.length === 0)) {
    return {
      ...base,
      status: "NEEDS_CLARIFICATION",
      missingRequirements: ["trigger", "outcome", "destination"],
      message: "CrazyLoops needs a little more detail before it can create a truthful workflow.",
      clarificationQuestions: [
        "What should start the automation, what should happen, and where should the result be stored?",
      ],
    };
  }

  const gmailSearch = asksForGmail && /\b(contains?|from|subject)\b/i.test(normalizedPrompt);
  const derivedGmailSearch = gmailSearch ? deriveGmailSearch(normalizedPrompt) : null;
  if (gmailSearch && !derivedGmailSearch) {
    return { ...base, status: "NEEDS_CLARIFICATION", missingRequirements: ["gmail search"], message: "CrazyLoops needs a specific sender, subject, or phrase for the Gmail filter.", clarificationQuestions: ["Which sender, subject, or exact phrase should the new Gmail message match?"] };
  }
  const slackTrigger = asksForSlack && (/\b(when|whenever)\b[^.]{0,80}\b(someone posts?|new message|message (?:is )?posted)\b/i.test(normalizedPrompt) || /\bnew slack (?:channel )?message\b/i.test(normalizedPrompt));
  const notionTrigger = asksForNotion && !/\b(manual(?:ly)?|when i run|on demand)\b/i.test(normalizedPrompt) && /\b(when|whenever)\b/i.test(normalizedPrompt) && /\b(updated?|changed?|created?|added?)\b/i.test(normalizedPrompt);
  const trigger = parsedSchedule?.ok
    ? plannedCapability("schedule.trigger", parsedSchedule.schedule.humanLabel)
    : slackTrigger
    ? plannedCapability("slack_new_channel_message", normalizedPrompt.match(/#[a-z0-9_-]+/i)?.[0])
    : notionTrigger
      ? plannedCapability(/\b(created?|added?|new)\b/i.test(normalizedPrompt) ? "notion_page_created_or_added" : "notion_page_updated")
    : asksForGmail && /\b(new|arrives?|received?|when)\b/i.test(normalizedPrompt)
    ? plannedCapability(gmailSearch ? "gmail_new_email_matching_search" : "gmail_new_email", derivedGmailSearch ?? undefined)
    : /\b(manual(?:ly)?|when i run|on demand)\b/i.test(normalizedPrompt)
      ? plannedCapability("manual_trigger")
    : detectsWebhookTrigger(normalizedPrompt)
    ? plannedCapability("generic_webhook_trigger")
    : detectsPublicFormTrigger(normalizedPrompt)
      ? plannedCapability("public_form_submission")
      : null;
  const httpCapability = httpPlanning.capability;
  const transformations = [
    ...(httpCapability?.http?.method === "GET" ? [httpCapability] : []),
    ...formatterTransformations,
    ...detectTransformations(normalizedPrompt),
  ];
  const condition = parseCondition(normalizedPrompt);
  if (condition?.usesAiClassification && !transformations.some((item) => /classif/i.test(item.instruction ?? ""))) {
    transformations.push(plannedCapability("ai_text_transform", `Classify whether the input matches this criterion: ${condition.humanLabel.replace(/^If\s+/i, "")}. Return a short, direct classification.`));
  }
  if (asksForNotion && /\b(find|lookup)\b/i.test(normalizedPrompt) && /\bupdate\b/i.test(normalizedPrompt)) transformations.unshift(plannedCapability("notion_find_item", "Find exactly one matching Notion item."));
  const branchParts = condition ? normalizedPrompt.split(/\botherwise\b|\belse\b/i) : [];
  const trueBranchText = condition ? (branchParts[0].split(/\bthen\b/i).at(-1) ?? branchParts[0]) : normalizedPrompt;
  const falseBranchText = condition && branchParts.length > 1 ? branchParts.slice(1).join(" ") : "";
  // Branch text is evaluated independently from the trigger clause. Carrying the
  // full prompt's webhook flag into a branch can turn an internal `otherwise
  // store ...` branch into an outbound HTTP action merely because the workflow
  // starts from a webhook.
  const destinationOptions = { asksForGmail: false, asksForSheets: false, asksForSlack: false, asksForNotion: false, asksForWebhook: false, triggerPresent: Boolean(trigger) };
  const detectedDestination = condition
    ? detectDestination(trueBranchText, destinationOptions)
    : detectDestination(normalizedPrompt, { ...destinationOptions, asksForGmail, asksForSheets, asksForSlack, asksForNotion });
  const destination = httpCapability && httpCapability.http?.method !== "GET"
    ? httpCapability
    : httpCapability?.http?.method === "GET" && detectedDestination?.capabilityId === "generic_http_action" && detectsInternalDestination(normalizedPrompt)
      ? plannedCapability("flowmind_data_store")
    : detectedDestination?.capabilityId === "generic_http_action" && httpCapability
      ? httpCapability
      : detectedDestination;
  const otherwiseDestination = condition && falseBranchText
    ? detectDestination(falseBranchText, destinationOptions)
    : null;
  const missingRequirements: string[] = [];
  const clarificationQuestions: string[] = [];

  if (!trigger) {
    missingRequirements.push("trigger");
    clarificationQuestions.push(
      "Should this start from a CrazyLoops hosted form submission?",
    );
  }
  if (!destination) {
    missingRequirements.push("destination");
    clarificationQuestions.push(
      "Should the result be stored inside CrazyLoops or generated as a PDF?",
    );
  }

  if (missingRequirements.length > 0) {
    return {
      ...base,
      status: "NEEDS_CLARIFICATION",
      trigger,
      transformations,
      destination,
      otherwiseDestination,
      condition,
      schedule: parsedSchedule?.ok ? parsedSchedule.schedule : null,
      missingRequirements,
      message: `CrazyLoops needs ${missingRequirements.join(" and ")} details before building this workflow.`,
      clarificationQuestions,
    };
  }

  return {
    ...base,
    status: "READY_TO_COMPILE",
    trigger,
    transformations,
    destination,
    otherwiseDestination,
    condition,
    schedule: parsedSchedule?.ok ? parsedSchedule.schedule : null,
    message: "This request matches capabilities that CrazyLoops can execute.",
  };
}
