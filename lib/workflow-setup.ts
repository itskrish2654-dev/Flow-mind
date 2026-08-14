import type { CompiledWorkflow, StepInput } from "@/lib/schemas/workflow";

type WorkflowStep = CompiledWorkflow["steps"][number];

export function orderWorkflowSteps(steps: WorkflowStep[]): WorkflowStep[] {
  // Step order is part of the compiled plan. Never manufacture trigger/AI/action order.
  return [...steps];
}

const hiddenJargon =
  /webhook|api(?:\s+key)?|http|json|payload|endpoint|auth(?:entication)?\s+token/i;

export function toPlainEnglish(text: string): string {
  return text
    .split(/(https?:\/\/[^\s]+)/g)
    .map((part) => {
      if (/^https?:\/\//i.test(part)) return part;
      return part
        .replace(/\bHTTP\s+POST(?:\s+request)?\b/gi, "send step")
        .replace(/\bAPI\s+(?:key|secret|token)\b/gi, "security key")
        .replace(/\bauth(?:entication)?\s+token\b/gi, "security key")
        .replace(/\bwebhook(?:\s+(?:URL|link))?\b/gi, "delivery link")
        .replace(/\bendpoint\b/gi, "destination")
        .replace(/\bpayload\b/gi, "information")
        .replace(/\bJSON\b/gi, "information")
        .replace(/\bLLM\b/gi, "FlowMind AI")
        .replace(/\bAPI\b/gi, "app connection")
        .replace(/\bHTTP\b/gi, "sending")
        .replace(/\bURL\b/gi, "link");
    })
    .join("");
}

function fallbackLabel(step: WorkflowStep, input: StepInput): string {
  if (!hiddenJargon.test(input.label)) return input.label;
  if (input.type === "secret") return "Security key for this app";
  if (input.type === "url") return "Where should FlowMind send the result?";
  if (step.type === "filter_condition") return "What should FlowMind check?";
  return "What information should FlowMind use?";
}

function fallbackHelpText(step: WorkflowStep, input: StepInput): string {
  if (input.type === "secret") {
    return "This private key lets FlowMind connect to the app you chose.";
  }
  if (input.type === "url") {
    return "This is the public destination that should acknowledge a test delivery.";
  }
  if (step.type === "filter_condition") {
    return "Describe the rule FlowMind should check before it continues.";
  }
  return "Tell FlowMind what you want it to do in your own words.";
}

function fallbackGuide(step: WorkflowStep, input: StepInput): string {
  if (input.type === "secret") {
    return "Open the destination app's connection settings, create a private key, and paste it here.";
  }
  if (input.type === "url") {
    return "Create a temporary public test URL, copy it, and paste it here.";
  }
  if (step.type === "filter_condition") {
    return "Write one clear rule and the result expected when that rule is true.";
  }
  return "Describe the desired result, including tone, length, and format when relevant.";
}

function defaultInputs(step: WorkflowStep): StepInput[] {
  switch (step.type) {
    case "public_form_trigger":
    case "webhook_trigger":
    case "store_data":
    case "ai_transform":
      return [];
    case "webhook_post":
    case "http_request":
      return [
        {
          key: "destination_url",
          label: "Public test destination",
          type: "url",
          placeholder: "https://webhook.site/your-test-id",
          helpText:
            "FlowMind marks delivery successful only after this destination accepts the request.",
          howToGetIt:
            "Open Webhook.site, copy your unique URL, and paste it here. This connection is test-only.",
        },
      ];
    case "generate_pdf":
      return [
        {
          key: "document_template",
          label: "Document Template",
          type: "text",
          value:
            step.config?.documentTemplate ??
            `# ${step.title}\n\nPrepared for {{trigger.name}}\n\n{{trigger.details}}\n\n## Result\n\n{{ai.result}}`,
          placeholder:
            "# Customer Proposal\n\nHello {{trigger.name}},\n\n{{ai.result}}",
          helpText:
            "Write plain text or Markdown and add earlier values with curly braces.",
          howToGetIt:
            "Add the document text, then insert form or AI values such as {{trigger.name}} or {{ai.result}}.",
        },
      ];
    case "filter_condition":
    case "connector_trigger":
    case "connector_action":
      return [];
  }
}

function enrichInput(step: WorkflowStep, input: StepInput): StepInput {
  const safePlaceholder =
    input.placeholder && !hiddenJargon.test(input.placeholder)
      ? input.placeholder
      : input.type === "secret"
        ? "Paste the private security key"
        : input.type === "url"
          ? "Paste the public link here"
          : undefined;
  return {
    ...input,
    ...(["webhook_post", "http_request"].includes(step.type) && input.type === "url"
      ? { value: step.config?.endpoint ?? input.value }
      : {}),
    label: toPlainEnglish(fallbackLabel(step, input)),
    ...(safePlaceholder ? { placeholder: safePlaceholder } : {}),
    helpText: toPlainEnglish(input.helpText ?? fallbackHelpText(step, input)),
    howToGetIt: toPlainEnglish(input.howToGetIt ?? fallbackGuide(step, input)),
  };
}

export function getStepInputs(
  step: WorkflowStep,
  workflowId: string | null,
): StepInput[] {
  void workflowId;
  if (step.type === "generate_pdf") {
    return defaultInputs(step).map((input) => enrichInput(step, input));
  }
  const suppliedInputs = step.inputsRequired ?? [];
  return (suppliedInputs.length > 0 ? suppliedInputs : defaultInputs(step)).map(
    (input) => enrichInput(step, input),
  );
}
