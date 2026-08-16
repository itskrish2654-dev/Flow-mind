import {
  findRequestedUnsupportedCapabilities,
  getCapability,
  type CapabilityDefinition,
  type CapabilityId,
} from "@/lib/capability-registry";
import { parseScheduleLanguage, type ScheduleDefinition } from "@/lib/scheduling";

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
  if (asksForSlack && /\b(send|post|alert|notify|message)\b/i.test(prompt)) return plannedCapability("slack_send_channel_message");
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
  const asksForWebhook = /\bwebhook(?:\.site)?\b/i.test(normalizedPrompt);
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

  if (!normalizedPrompt || (isVaguePrompt(normalizedPrompt) && !parsedSchedule)) {
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
  const transformations = detectTransformations(normalizedPrompt);
  const condition = parseCondition(normalizedPrompt);
  if (condition?.usesAiClassification && !transformations.some((item) => /classif/i.test(item.instruction ?? ""))) {
    transformations.push(plannedCapability("ai_text_transform", `Classify whether the input matches this criterion: ${condition.humanLabel.replace(/^If\s+/i, "")}. Return a short, direct classification.`));
  }
  if (asksForNotion && /\b(find|lookup)\b/i.test(normalizedPrompt) && /\bupdate\b/i.test(normalizedPrompt)) transformations.unshift(plannedCapability("notion_find_item", "Find exactly one matching Notion item."));
  const branchParts = condition ? normalizedPrompt.split(/\botherwise\b|\belse\b/i) : [];
  const trueBranchText = condition ? (branchParts[0].split(/\bthen\b/i).at(-1) ?? branchParts[0]) : normalizedPrompt;
  const falseBranchText = condition && branchParts.length > 1 ? branchParts.slice(1).join(" ") : "";
  const destinationOptions = { asksForGmail: false, asksForSheets: false, asksForSlack: false, asksForNotion: false, asksForWebhook, triggerPresent: Boolean(trigger) };
  const destination = condition
    ? detectDestination(trueBranchText, destinationOptions)
    : detectDestination(normalizedPrompt, { ...destinationOptions, asksForGmail, asksForSheets, asksForSlack, asksForNotion });
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
