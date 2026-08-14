import { compileReadyPlan } from "@/lib/workflow-compiler";
import { planWorkflow } from "@/lib/workflow-planner";

export const HOMEPAGE_DEMO_MAX_PROMPT_LENGTH = 600;

export type HomepageDemoStep = {
  id: string;
  label: string;
  detail: string;
  category: "trigger" | "ai" | "document" | "storage" | "destination";
};

export type HomepageDemoResult =
  | {
      status: "supported";
      steps: HomepageDemoStep[];
      message: string;
      plannerStatus: "READY_TO_COMPILE";
    }
  | {
      status: "unsupported";
      title: "PART OF THIS LOOP ISN'T AVAILABLE YET.";
      message: string;
      plannerStatus: "UNSUPPORTED";
    }
  | {
      status: "clarification";
      question: string;
      message: string;
      plannerStatus: "NEEDS_CLARIFICATION" | "CONFLICTING_REQUIREMENTS";
      canClarify: boolean;
    };

function plannerPrompt(prompt: string, clarification?: string): string {
  const combined = clarification
    ? `${prompt.trim()} Clarification: ${clarification.trim()}`
    : prompt.trim();

  // "A new request comes in" is the homepage's plain-language shorthand for
  // the supported hosted-form trigger. The planner still owns capability
  // validation; this only makes the trigger explicit before planning.
  return /\bwhen a new request comes in\b/i.test(combined) &&
    !/\b(form|submission|webhook|gmail|manual|on demand)\b/i.test(combined)
    ? `${combined} The request comes from a CrazyLoops hosted form submission.`
    : combined;
}

function joinDisplayNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "That capability";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function previewSteps(prompt: string, plannedPrompt: string): HomepageDemoStep[] {
  const plan = planWorkflow(plannedPrompt);
  if (plan.status !== "READY_TO_COMPILE") return [];
  const workflow = compileReadyPlan(prompt, plan);
  const steps: HomepageDemoStep[] = [];

  for (const step of workflow.steps) {
    if (step.type === "public_form_trigger") {
      steps.push({ id: step.id, label: "Request", detail: "Hosted form submission", category: "trigger" });
    } else if (step.type === "webhook_trigger") {
      steps.push({ id: step.id, label: "Webhook", detail: "Authenticated event received", category: "trigger" });
    } else if (step.type === "connector_trigger") {
      steps.push({ id: step.id, label: step.title, detail: "Connected event received", category: "trigger" });
    } else if (step.type === "ai_transform") {
      steps.push({ id: step.id, label: "AI", detail: step.title, category: "ai" });
    } else if (step.type === "generate_pdf") {
      steps.push({ id: step.id, label: "PDF", detail: "Private document created", category: "document" });
      // PDF generation stores the private file as part of the same supported
      // implementation. It is shown as a distinct outcome, not a connector.
      steps.push({ id: `${step.id}_storage`, label: "Store", detail: "Private file saved", category: "storage" });
    } else if (step.type === "store_data") {
      steps.push({ id: step.id, label: "Store", detail: "Result saved in CrazyLoops", category: "storage" });
    } else {
      steps.push({ id: step.id, label: step.title, detail: step.description, category: "destination" });
    }
  }

  return steps;
}

export function planHomepageDemo(
  prompt: string,
  clarification?: string,
  clarificationTurn = 0,
): HomepageDemoResult {
  const plannedPrompt = plannerPrompt(prompt, clarification);
  const plan = planWorkflow(plannedPrompt);

  if (plan.status === "UNSUPPORTED") {
    const names = plan.requestedUnsupportedCapabilities
      .map(({ displayName }) => displayName)
      .sort((left, right) => {
        const normalized = prompt.toLowerCase();
        return normalized.indexOf(left.toLowerCase()) - normalized.indexOf(right.toLowerCase());
      });
    const subject = joinDisplayNames(names);
    return {
      status: "unsupported",
      title: "PART OF THIS LOOP ISN'T AVAILABLE YET.",
      message: names.length === 1
        ? `${subject} isn't supported yet.`
        : `${subject} aren't supported yet.`,
      plannerStatus: "UNSUPPORTED",
    };
  }

  if (plan.status === "CONFLICTING_REQUIREMENTS") {
    return {
      status: "clarification",
      question: plan.clarificationQuestions[0] ?? "Which requirement should CrazyLoops follow?",
      message: plan.message,
      plannerStatus: "CONFLICTING_REQUIREMENTS",
      canClarify: clarificationTurn < 1,
    };
  }

  if (plan.status === "NEEDS_CLARIFICATION") {
    const question = plan.missingRequirements.includes("trigger") && plan.missingRequirements.includes("destination")
      ? "Where should the request come from, and where should the finished result go?"
      : plan.clarificationQuestions[0] ?? "What should CrazyLoops know before building this loop?";
    return {
      status: "clarification",
      question,
      message: plan.message,
      plannerStatus: "NEEDS_CLARIFICATION",
      canClarify: clarificationTurn < 1,
    };
  }

  const steps = previewSteps(prompt, plannedPrompt);
  return {
    status: "supported",
    steps,
    message: `${steps.length} steps. Nothing to wire together.`,
    plannerStatus: "READY_TO_COMPILE",
  };
}
