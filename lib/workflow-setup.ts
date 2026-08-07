import type { CompiledWorkflow, StepInput } from "@/lib/schemas/workflow";

export type WorkflowStep = CompiledWorkflow["steps"][number];

export const friendlyStepCopy: Record<
  WorkflowStep["type"],
  {
    icon: string;
    label: string;
    title: string;
    description: string;
    color: string;
    numberColor: string;
  }
> = {
  webhook_trigger: {
    icon: "⚡",
    label: "WHEN THIS HAPPENS",
    title: "Something starts your automation",
    description: "FlowPilot notices when new information arrives and gets started.",
    color: "border-violet-200 bg-violet-50 text-violet-700",
    numberColor: "bg-violet-600 text-white shadow-violet-200",
  },
  ai_transform: {
    icon: "✨",
    label: "AI MAGIC",
    title: "FlowPilot works with your information",
    description: "FlowPilot reads, summarizes, or improves the information for you.",
    color: "border-indigo-200 bg-indigo-50 text-indigo-700",
    numberColor: "bg-indigo-600 text-white shadow-indigo-200",
  },
  http_request: {
    icon: "🚀",
    label: "SEND THE RESULT",
    title: "Your result goes to the right place",
    description: "FlowPilot sends the finished result to the app you choose.",
    color: "border-emerald-200 bg-emerald-50 text-emerald-700",
    numberColor: "bg-emerald-600 text-white shadow-emerald-200",
  },
  filter_condition: {
    icon: "🔍",
    label: "CHECK A RULE",
    title: "FlowPilot checks what should happen next",
    description: "FlowPilot checks your rule before continuing.",
    color: "border-amber-200 bg-amber-50 text-amber-700",
    numberColor: "bg-amber-500 text-white shadow-amber-200",
  },
};

const primaryStepOrder: WorkflowStep["type"][] = [
  "webhook_trigger",
  "ai_transform",
  "http_request",
];

export function orderWorkflowSteps(steps: WorkflowStep[]): WorkflowStep[] {
  const primarySteps = primaryStepOrder.map((type) =>
    steps.find((step) => step.type === type),
  );

  if (primarySteps.every((step): step is WorkflowStep => Boolean(step))) {
    return primarySteps;
  }

  return [...steps].sort(
    (first, second) =>
      primaryStepOrder.indexOf(first.type) - primaryStepOrder.indexOf(second.type),
  );
}

const hiddenJargon = /webhook|api(?:\s+key)?|http|json|payload|endpoint|auth(?:entication)?\s+token/i;

export function toPlainEnglish(text: string): string {
  return text
    .split(/(https?:\/\/[^\s]+)/g)
    .map((part) => {
      if (/^https?:\/\//i.test(part)) return part;
      return part
        .replace(/\bHTTP\s+POST(?:\s+request)?\b/gi, "send step")
        .replace(/\bAPI\s+(?:key|secret|token)\b/gi, "security key")
        .replace(/\bauth(?:entication)?\s+token\b/gi, "security key")
        .replace(/\bwebhook(?:\s+(?:URL|link))?\b/gi, "listening link")
        .replace(/\bendpoint\b/gi, "destination")
        .replace(/\bpayload\b/gi, "information")
        .replace(/\bJSON\b/gi, "information")
        .replace(/\bLLM\b/gi, "FlowPilot")
        .replace(/\bAPI\b/gi, "app connection")
        .replace(/\bHTTP\b/gi, "sending")
        .replace(/\bURL\b/gi, "link");
    })
    .join("");
}

function fallbackLabel(step: WorkflowStep, input: StepInput): string {
  if (!hiddenJargon.test(input.label)) return input.label;
  if (input.type === "secret") return "🔑 Security key for this app";
  if (input.type === "url") return "Where should FlowPilot send the result?";
  if (step.type === "filter_condition") return "What should FlowPilot check?";
  return "What information should FlowPilot use?";
}

function fallbackHelpText(step: WorkflowStep, input: StepInput): string {
  if (input.type === "secret") {
    return "This private key lets FlowPilot safely connect to the app you chose.";
  }
  if (input.type === "url") {
    return "This tells FlowPilot exactly where you want the finished result to go.";
  }
  if (step.type === "filter_condition") {
    return "Describe the simple rule FlowPilot should check before it continues.";
  }
  return "Tell FlowPilot what you want it to do in your own words.";
}

function fallbackGuide(step: WorkflowStep, input: StepInput): string {
  if (input.type === "secret") {
    return [
      "1. Sign in to the app you want FlowPilot to use.",
      "2. Open Settings, then look for Security or Connections.",
      "3. Copy the private security key shown there and paste it above.",
    ].join("\n");
  }
  if (input.type === "url") {
    return [
      "1. Sign in to the app where you want to receive the result.",
      "2. Open its sharing or connection settings.",
      "3. Copy the destination link it provides and paste it above.",
    ].join("\n");
  }
  if (step.type === "filter_condition") {
    return [
      "1. Think about the one rule that should be checked.",
      "2. Write the rule as a simple sentence.",
      "3. Add the result you expect when the rule is true.",
    ].join("\n");
  }
  return [
    "1. Think about the result you want FlowPilot to create.",
    "2. Describe it in one clear sentence.",
    "3. Add any tone, length, or style you prefer.",
  ].join("\n");
}

function emailListeningLink(workflowId: string | null): StepInput {
  return {
    key: "flowpilot_listening_link",
    label: "🔗 Your Unique FlowPilot Trigger Link",
    type: "url",
    value: `https://flowpilot.dev/listen/${workflowId ?? "your-automation"}`,
    helpText:
      "Paste this link into your email app's forwarding settings so FlowPilot knows when an email arrives.",
    howToGetIt: [
      "1. FlowPilot created this link for you—click Copy Link below.",
      "2. Open your email app and go to its forwarding settings.",
      "3. Paste the link there and save your changes.",
    ].join("\n"),
  };
}

function stepContext(step: WorkflowStep): string {
  return `${step.title} ${step.description}`.toLowerCase();
}

function trendingTopicsInput(): StepInput {
  return {
    key: "trending_topics_source",
    label: "Where should FlowPilot check for trending topics?",
    type: "url",
    placeholder: "e.g. https://trends.google.com/trends/rss or a news RSS feed URL",
    helpText: "Choose the trends or news source FlowPilot should check before writing.",
    howToGetIt: [
      "1. Go to https://trends.google.com/trends/rss or your favorite news RSS feed.",
      "2. Open the feed you want FlowPilot to follow.",
      "3. Copy the RSS or feed link and paste it here.",
    ].join("\n"),
  };
}

function youtubeScriptInstructions(): StepInput {
  return {
    key: "script_instructions",
    label: "AI Script Prompt Instructions",
    type: "text",
    placeholder:
      "e.g. Create an engaging 5-minute YouTube script with an introduction, 3 main points, and a call to action.",
    helpText: "Describe the length, style, structure, and audience for your script.",
    howToGetIt: [
      "1. Choose the ideal length for your YouTube video.",
      "2. List the sections you want, such as an introduction and three main points.",
      "3. Add the tone and the final action you want viewers to take.",
    ].join("\n"),
  };
}

function youtubeScriptDestination(): StepInput {
  return {
    key: "completed_script_destination",
    label: "Where should FlowPilot save or send your completed script?",
    type: "text",
    placeholder: "e.g. Enter your email address, Google Doc link, or Notion connection link",
    helpText: "Choose the place where you want the finished YouTube script to arrive.",
    howToGetIt: [
      "1. Choose email, Google Docs, or Notion as your destination.",
      "2. Open https://docs.google.com or https://www.notion.so and create the page you want to use.",
      "3. Copy its sharing link, or enter your email address, and paste it here.",
    ].join("\n"),
  };
}

function defaultInputs(step: WorkflowStep, workflowId: string | null): StepInput[] {
  const context = stepContext(step);
  const isYouTubeScript = /\byoutube\b|\bscript\b/.test(context);
  const usesTrendingTopics = context.includes("trend") || context.includes("rss");

  switch (step.type) {
    case "webhook_trigger":
      if (usesTrendingTopics || isYouTubeScript) return [trendingTopicsInput()];
      if (context.includes("email")) return [emailListeningLink(workflowId)];
      if (context.includes("schedule") || context.includes("every day")) {
        return [
          {
            key: "schedule",
            label: "When should FlowPilot run this automation?",
            type: "text",
            placeholder: "e.g. Every weekday at 9:00 AM",
            helpText: "Choose the days and time that work best for you.",
            howToGetIt: [
              "1. Pick the days when you want this automation to run.",
              "2. Choose a time and check your local time zone.",
              "3. Write the full schedule here.",
            ].join("\n"),
          },
        ];
      }
      return [
        {
          key: "starting_source",
          label: "Where should FlowPilot look for new information?",
          type: "url",
          placeholder: "Paste the source link here",
          helpText: "Choose the app or page that should start this automation.",
          howToGetIt: [
            "1. Open the app or page where the new information appears.",
            "2. Open its sharing or connection settings.",
            "3. Copy the source link and paste it here.",
          ].join("\n"),
        },
      ];
    case "ai_transform":
      if (isYouTubeScript) return [youtubeScriptInstructions()];
      return [
        {
          key: "instructions",
          label: "What should FlowPilot create or change?",
          type: "text",
          placeholder: "Create a bold, easy-to-read thumbnail",
          helpText: "Describe the result you want in the same words you would use with a person.",
          howToGetIt: fallbackGuide(step, { key: "instructions", label: "", type: "text" }),
        },
      ];
    case "http_request":
      if (isYouTubeScript) return [youtubeScriptDestination()];
      return [
        {
          key: "destination_link",
          label: "Where should FlowPilot send the result?",
          type: "url",
          placeholder: "Paste the destination link here",
          helpText: "This tells FlowPilot which app should receive the finished result.",
          howToGetIt: fallbackGuide(step, { key: "destination_link", label: "", type: "url" }),
        },
        {
          key: "security_key",
          label: "🔑 Security key for your destination app",
          type: "secret",
          placeholder: "Paste your private security key",
          helpText: "This private key lets FlowPilot safely connect to the app you chose.",
          howToGetIt: fallbackGuide(step, { key: "security_key", label: "", type: "secret" }),
        },
      ];
    case "filter_condition":
      return [
        {
          key: "rule",
          label: "What should FlowPilot check?",
          type: "text",
          placeholder: "Choose the thumbnail with the most clicks after 48 hours",
          helpText: "Describe the simple rule FlowPilot should check before it continues.",
          howToGetIt: fallbackGuide(step, { key: "rule", label: "", type: "text" }),
        },
      ];
  }
}

function enrichInput(step: WorkflowStep, input: StepInput): StepInput {
  const safePlaceholder = input.placeholder && !hiddenJargon.test(input.placeholder)
    ? input.placeholder
    : input.type === "secret"
      ? "Paste the private security key"
      : input.type === "url"
        ? "Paste the link here"
        : undefined;

  return {
    ...input,
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
  const suppliedInputs = (step.inputsRequired ?? []).map((input) =>
    enrichInput(step, input),
  );
  return suppliedInputs.length > 0 ? suppliedInputs : defaultInputs(step, workflowId);
}
