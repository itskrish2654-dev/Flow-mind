import {
  findRequestedUnsupportedCapabilities,
  getCapability,
  type CapabilityDefinition,
  type CapabilityId,
} from "@/lib/capability-registry";

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

export type WorkflowPlan = {
  status: PlanningStatus;
  intent: string;
  trigger: PlannedCapability | null;
  transformations: PlannedCapability[];
  destination: PlannedCapability | null;
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
  if (!capability) throw new Error(`Unknown FlowMind capability: ${capabilityId}`);
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
      "The request asks FlowMind to act automatically and also wait for approval before acting.",
    );
  }
  if (/\bnever store\b/i.test(prompt) && /\b(history|previous|store|save|data table)\b/i.test(prompt)) {
    contradictions.push(
      "The request says not to store data but also asks FlowMind to retain it.",
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
  return /\b(flowmind|internal(?:ly)?|data table|store|save|record|keep)\b/i.test(prompt);
}

function detectsPdfDestination(prompt: string): boolean {
  return /\b(pdf|invoice|proposal|document|downloadable report)\b/i.test(prompt);
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
      message: "These requirements conflict, so FlowMind will not invent a compromise.",
      clarificationQuestions: [
        "Should this automation act automatically, or wait for a person to approve it?",
      ],
    };
  }

  const asksForGmail = /\bgmail\b/i.test(normalizedPrompt);
  const asksForSheets = /\bgoogle sheets?\b|\bsheets?\b/i.test(normalizedPrompt);
  const unsupported = findRequestedUnsupportedCapabilities(normalizedPrompt).filter((capability) => !(asksForGmail && ["email_ingestion", "email_delivery"].includes(capability.id)));
  if (
    /\b(every\s+(?:hour|weekday|day|week|month|morning|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)|on a schedule)\b/i.test(
      normalizedPrompt,
    )
  ) {
    const scheduling = getCapability("schedule_trigger");
    if (scheduling) unsupported.push(scheduling);
  }
  const asksForWebhook = /\bwebhook(?:\.site)?\b/i.test(normalizedPrompt);
  const asksForUnknownExternalConnection =
    /\b(connect(?:\s+to)?|sync\s+(?:to|with)|post\s+(?:it\s+)?to)\b/i.test(
      normalizedPrompt,
    ) &&
    !/\b(flowmind|pdf|document|webhook|http request|gmail|google sheets?|sheets?)\b/i.test(normalizedPrompt) &&
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

  if (!normalizedPrompt || isVaguePrompt(normalizedPrompt)) {
    return {
      ...base,
      status: "NEEDS_CLARIFICATION",
      missingRequirements: ["trigger", "outcome", "destination"],
      message: "FlowMind needs a little more detail before it can create a truthful workflow.",
      clarificationQuestions: [
        "What should start the automation, what should happen, and where should the result be stored?",
      ],
    };
  }

  const gmailSearch = asksForGmail && /\b(contains?|from|subject)\b/i.test(normalizedPrompt);
  const derivedGmailSearch = gmailSearch ? deriveGmailSearch(normalizedPrompt) : null;
  if (gmailSearch && !derivedGmailSearch) {
    return { ...base, status: "NEEDS_CLARIFICATION", missingRequirements: ["gmail search"], message: "FlowMind needs a specific sender, subject, or phrase for the Gmail filter.", clarificationQuestions: ["Which sender, subject, or exact phrase should the new Gmail message match?"] };
  }
  const trigger = asksForGmail && /\b(new|arrives?|received?|when)\b/i.test(normalizedPrompt)
    ? plannedCapability(gmailSearch ? "gmail_new_email_matching_search" : "gmail_new_email", derivedGmailSearch ?? undefined)
    : /\b(manual(?:ly)?|when i run|on demand)\b/i.test(normalizedPrompt)
      ? plannedCapability("manual_trigger")
    : detectsWebhookTrigger(normalizedPrompt)
    ? plannedCapability("generic_webhook_trigger")
    : detectsPublicFormTrigger(normalizedPrompt)
      ? plannedCapability("public_form_submission")
      : null;
  const transformations = detectTransformations(normalizedPrompt);
  const destination = asksForSheets
    ? plannedCapability(/\bupdate row\b/i.test(normalizedPrompt) ? "google_sheets_update_row" : /\bfind|lookup\b/i.test(normalizedPrompt) ? "google_sheets_find_row" : "google_sheets_add_row")
    : asksForGmail && /\breply\b/i.test(normalizedPrompt)
      ? plannedCapability("gmail_reply_to_email")
      : asksForGmail && /\b(send|email it|mail it)\b/i.test(normalizedPrompt)
        ? plannedCapability("gmail_send_email")
    : detectsHttpDestination(normalizedPrompt) || (asksForWebhook && !detectsWebhookTrigger(normalizedPrompt))
    ? plannedCapability("generic_http_action")
    : detectsPdfDestination(normalizedPrompt)
    ? plannedCapability("generate_pdf")
    : detectsInternalDestination(normalizedPrompt) || trigger
      ? plannedCapability("flowmind_data_store")
      : null;
  const missingRequirements: string[] = [];
  const clarificationQuestions: string[] = [];

  if (!trigger) {
    missingRequirements.push("trigger");
    clarificationQuestions.push(
      "Should this start from a FlowMind hosted form submission?",
    );
  }
  if (!destination) {
    missingRequirements.push("destination");
    clarificationQuestions.push(
      "Should the result be stored inside FlowMind or generated as a PDF?",
    );
  }

  if (missingRequirements.length > 0) {
    return {
      ...base,
      status: "NEEDS_CLARIFICATION",
      trigger,
      transformations,
      destination,
      missingRequirements,
      message: `FlowMind needs ${missingRequirements.join(" and ")} details before building this workflow.`,
      clarificationQuestions,
    };
  }

  return {
    ...base,
    status: "READY_TO_COMPILE",
    trigger,
    transformations,
    destination,
    message: "This request matches capabilities that FlowMind can execute.",
  };
}
