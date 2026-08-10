"use server";

import { groq } from "@ai-sdk/groq";
import { generateText, Output } from "ai";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  CompiledWorkflowSchema,
  DataTableDefinitionSchema,
  PublicFormDefinitionSchema,
  type CompiledWorkflow,
  type DataTableDefinition,
  type PublicFormDefinition,
  type StepInput,
} from "@/lib/schemas/workflow";
import { getAuthenticatedContext } from "@/lib/auth";
import { createPublicFormDefinition } from "@/lib/public-form";
import { createDefaultDataTableDefinition } from "@/lib/workflow-customization";

const MAX_PROMPT_LENGTH = 10_000;

const GroqCompiledWorkflowSchema = z.object({
  workflowName: z.string(),
  summary: z.string(),
  steps: z.array(
    z.object({
      id: z.string(),
      type: z.enum([
        "webhook_trigger",
        "ai_transform",
        "http_request",
        "generate_pdf",
        "filter_condition",
      ]),
      title: z.string(),
      description: z.string(),
      inputsRequired: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          type: z.enum(["text", "url", "secret"]),
          placeholder: z.string().nullable(),
          value: z.string().nullable(),
          helpText: z.string().nullable(),
          howToGetIt: z.string().nullable(),
        }),
      ),
      config: z.object({
        endpoint: z.string().nullable(),
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).nullable(),
        transformPrompt: z.string().nullable(),
        documentTemplate: z.string().max(50_000).nullable(),
      }),
    }),
  ).length(3),
});

const REQUIRED_STEP_ORDER = [
  "webhook_trigger",
  "ai_transform",
] as const;

function isPdfWorkflow(prompt: string): boolean {
  return /\b(pdf|invoice|proposal|document|report)\b/i.test(prompt);
}

function defaultDocumentTemplate(workflowName: string): string {
  return `# ${workflowName}\n\nPrepared for {{trigger.name}}\n\n{{trigger.query}}\n\n## Summary\n\n{{ai.summary}}`;
}

function normalizeDocumentTemplate(
  template: string | null,
  workflowName: string,
): string {
  const source = template?.trim() || defaultDocumentTemplate(workflowName);
  return source.replace(
    /\{\{\s*(ai_[a-zA-Z0-9_.-]+)\s*\}\}/g,
    (placeholder, key: string) =>
      ["ai_summary", "ai_result"].includes(key.toLowerCase())
        ? placeholder
        : "{{ai_summary}}",
  );
}

function isYouTubeScriptWorkflow(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return normalized.includes("youtube") && normalized.includes("script");
}

function youtubeScriptInput(stepIndex: number): StepInput[] {
  if (stepIndex === 0) {
    return [
      {
        key: "trending_topics_source",
        label: "Where should FlowPilot check for trending topics?",
        type: "url",
        placeholder:
          "e.g. https://trends.google.com/trends/rss or a news RSS feed URL",
        helpText:
          "Choose the trusted trends or news source FlowPilot should check before writing.",
        howToGetIt: [
          "1. Go to https://trends.google.com/trends/rss or your favorite news RSS feed.",
          "2. Open the feed you want FlowPilot to follow.",
          "3. Copy the RSS or feed link and paste it here.",
        ].join("\n"),
      },
    ];
  }

  if (stepIndex === 1) {
    return [
      {
        key: "script_instructions",
        label: "AI Script Prompt Instructions",
        type: "text",
        placeholder:
          "e.g. Create an engaging 5-minute YouTube script with an introduction, 3 main points, and a call to action.",
        helpText:
          "Describe the length, style, structure, and audience for the script you want.",
        howToGetIt: [
          "1. Choose the ideal length for your YouTube video.",
          "2. List the sections you want, such as an introduction and three main points.",
          "3. Add the tone and the final action you want viewers to take.",
        ].join("\n"),
      },
    ];
  }

  return [
    {
      key: "completed_script_destination",
      label: "Where should FlowPilot save or send your completed script?",
      type: "text",
      placeholder:
        "e.g. Enter your email address, Google Doc link, or Notion connection link",
      helpText:
        "Choose the place where you want the finished YouTube script to arrive.",
      howToGetIt: [
        "1. Choose email, Google Docs, or Notion as your destination.",
        "2. Open https://docs.google.com or https://www.notion.so and create the page you want to use.",
        "3. Copy its sharing link, or enter your email address, and paste it here.",
      ].join("\n"),
    },
  ];
}

function getRawFailedModelOutput(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;

  const directError = error as {
    text?: unknown;
    value?: unknown;
    cause?: unknown;
    responseBody?: unknown;
    data?: unknown;
  };
  const directOutput = directError.text ?? directError.value;
  if (directOutput !== undefined) return directOutput;

  if (typeof directError.responseBody === "string") {
    try {
      const response = JSON.parse(directError.responseBody) as {
        error?: { failed_generation?: unknown };
      };
      if (response.error?.failed_generation !== undefined) {
        return response.error.failed_generation;
      }
    } catch {
      // Keep the full provider response available when it is not valid JSON.
      return directError.responseBody;
    }
  }

  if (directError.data && typeof directError.data === "object") {
    const data = directError.data as {
      failed_generation?: unknown;
      error?: { failed_generation?: unknown };
    };
    const providerOutput = data.failed_generation ?? data.error?.failed_generation;
    if (providerOutput !== undefined) return providerOutput;
  }

  if (directError.cause && typeof directError.cause === "object") {
    const cause = directError.cause as { text?: unknown; value?: unknown };
    return cause.text ?? cause.value;
  }

  return undefined;
}

export type CompileWorkflowResult =
  | { success: true; id: string; workflow: CompiledWorkflow }
  | { success: false; error: string };

export type GetWorkflowResult =
  | {
      ok: true;
      workflow: CompiledWorkflow | null;
      name: string;
      prompt: string;
    }
  | { ok: false; error: string };

export type SavedWorkflow = {
  id: string;
  name: string;
  prompt: string;
  workflow: CompiledWorkflow | null;
};

export type ListWorkflowsResult =
  | { ok: true; workflows: SavedWorkflow[] }
  | { ok: false; error: string };

export type DeleteWorkflowResult =
  | { ok: true }
  | { ok: false; error: string };

export type SaveDocumentTemplateResult =
  | { ok: true; workflow: CompiledWorkflow }
  | { ok: false; error: string };

export type SaveWorkflowCustomizationResult =
  | { ok: true; workflow: CompiledWorkflow }
  | { ok: false; error: string };

export async function saveWorkflowCustomization(
  workflowId: string,
  customization: {
    publicForm?: PublicFormDefinition;
    dataTable?: DataTableDefinition;
  },
): Promise<SaveWorkflowCustomizationResult> {
  const request = z
    .object({
      workflowId: z.string().uuid(),
      customization: z
        .object({
          publicForm: PublicFormDefinitionSchema.optional(),
          dataTable: DataTableDefinitionSchema.optional(),
        })
        .refine((value) => value.publicForm || value.dataTable, {
          message: "Choose something to customize before saving.",
        }),
    })
    .safeParse({ workflowId, customization });

  if (!request.success) {
    return {
      ok: false,
      error: request.error.issues[0]?.message ?? "The customization is invalid.",
    };
  }

  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };

  const { data, error } = await auth.supabase
    .from("workflows")
    .select("compiled_steps")
    .eq("id", request.data.workflowId)
    .eq("user_id", auth.user.id)
    .maybeSingle();

  const parsed = CompiledWorkflowSchema.safeParse(data?.compiled_steps);
  if (error || !parsed.success) {
    return { ok: false, error: "We couldn't find this workflow." };
  }

  const workflow = CompiledWorkflowSchema.parse({
    ...parsed.data,
    ...(request.data.customization.publicForm
      ? { publicForm: request.data.customization.publicForm }
      : {}),
    ...(request.data.customization.dataTable
      ? { dataTable: request.data.customization.dataTable }
      : {}),
  });

  const { error: updateError } = await auth.supabase
    .from("workflows")
    .update({ compiled_steps: workflow })
    .eq("id", request.data.workflowId)
    .eq("user_id", auth.user.id);

  if (updateError) {
    console.error("Supabase workflow customization update failed", {
      code: updateError.code,
      message: updateError.message,
    });
    return { ok: false, error: "We couldn't save these changes." };
  }

  revalidatePath(`/f/${request.data.workflowId}`);
  revalidatePath(`/dashboard/projects/${request.data.workflowId}`);
  return { ok: true, workflow };
}

export async function saveDocumentTemplate(
  workflowId: string,
  stepId: string,
  template: string,
): Promise<SaveDocumentTemplateResult> {
  const request = z
    .object({
      workflowId: z.string().uuid(),
      stepId: z.string().min(1).max(100),
      template: z.string().trim().min(1).max(50_000),
    })
    .safeParse({ workflowId, stepId, template });

  if (!request.success) {
    return { ok: false, error: "Add a document template before saving." };
  }

  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };

  const { data, error } = await auth.supabase
    .from("workflows")
    .select("compiled_steps")
    .eq("id", request.data.workflowId)
    .eq("user_id", auth.user.id)
    .maybeSingle();

  const parsed = CompiledWorkflowSchema.safeParse(data?.compiled_steps);
  if (error || !parsed.success) {
    return { ok: false, error: "We couldn’t find this document workflow." };
  }

  let matchedStep = false;
  const workflow: CompiledWorkflow = {
    ...parsed.data,
    steps: parsed.data.steps.map((step) => {
      if (step.id !== request.data.stepId || step.type !== "generate_pdf") {
        return step;
      }
      matchedStep = true;
      return {
        ...step,
        config: {
          ...step.config,
          documentTemplate: request.data.template,
        },
      };
    }),
  };

  if (!matchedStep) {
    return { ok: false, error: "We couldn’t find the PDF step to update." };
  }

  const { error: updateError } = await auth.supabase
    .from("workflows")
    .update({ compiled_steps: workflow })
    .eq("id", request.data.workflowId)
    .eq("user_id", auth.user.id);

  if (updateError) {
    console.error("Supabase document template update failed", {
      code: updateError.code,
      message: updateError.message,
    });
    return { ok: false, error: "We couldn’t save the document template." };
  }

  return { ok: true, workflow };
}

export async function deleteWorkflow(workflowId: string): Promise<DeleteWorkflowResult> {
  const parsedWorkflowId = z.string().uuid().safeParse(workflowId);
  if (!parsedWorkflowId.success) {
    return { ok: false, error: "We could not identify that automation." };
  }

  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };

  const { error } = await auth.supabase
    .from("workflows")
    .delete()
    .eq("id", parsedWorkflowId.data)
    .eq("user_id", auth.user.id);

  if (error) {
    console.error("Supabase workflow delete failed", {
      code: error.code,
      message: error.message,
    });
    return { ok: false, error: "We couldn’t delete that automation. Please try again." };
  }

  return { ok: true };
}

export async function listWorkflows(): Promise<ListWorkflowsResult> {
  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };

  const { data, error } = await auth.supabase
    .from("workflows")
    .select("id, name, prompt, compiled_steps")
    .eq("user_id", auth.user.id)
    .limit(30);

  if (error) {
    console.error("Supabase workflow list failed", {
      code: error.code,
      message: error.message,
    });
    return { ok: false, error: "We couldn’t load your automations." };
  }

  const workflows = (data ?? []).map((row) => {
    if (row.compiled_steps === null) {
      return {
        id: row.id,
        name: row.name,
        prompt: row.prompt,
        workflow: null,
      };
    }

    const parsed = CompiledWorkflowSchema.safeParse(row.compiled_steps);
    if (!parsed.success) {
      console.error("Saved workflow list item could not be read", {
        workflowId: row.id,
        issues: parsed.error.issues,
      });
    }

    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      workflow: parsed.success ? parsed.data : null,
    };
  });
  return { ok: true, workflows };
}

export async function compileWorkflow(
  prompt: string,
  existingWorkflowId: string | null = null,
): Promise<CompileWorkflowResult> {
  const normalizedPrompt = prompt.trim();
  const parsedExistingWorkflowId = existingWorkflowId
    ? z.string().uuid().safeParse(existingWorkflowId)
    : null;

  if (!normalizedPrompt) {
    return { success: false, error: "Describe the workflow you want to create." };
  }

  if (normalizedPrompt.length > MAX_PROMPT_LENGTH) {
    return {
      success: false,
      error: "Workflow descriptions must be 10,000 characters or fewer.",
    };
  }

  if (parsedExistingWorkflowId && !parsedExistingWorkflowId.success) {
    return { success: false, error: "We could not identify that draft automation." };
  }

  const auth = await getAuthenticatedContext();
  if (!auth) return { success: false, error: "Unauthorized" };

  if (!process.env.GROQ_API_KEY) {
    const configurationError = new Error("Groq is not configured on the server.");
    console.error("🔥 AI Compiler Error Details:", configurationError);
    return { success: false, error: configurationError.message };
  }

  try {
    const { output } = await generateText({
      model: groq("llama-3.3-70b-versatile"),
      output: Output.object({
        name: "compiled_workflow",
        description: "A safe, executable automation workflow plan.",
        schema: GroqCompiledWorkflowSchema,
      }),
      system: `You are an AI Workflow Compiler.
Translate the user's prompt into a 3-step workflow.

CRITICAL RULES:
1. OUTPUT RAW, VALID JSON ONLY. NO MARKDOWN. NO CODE BLOCKS (\`\`\`json).
2. You must perfectly match the expected JSON schema.
3. Step 1 must ALWAYS be a trigger. Step 2 must ALWAYS be AI magic. Step 3 must
   ALWAYS be a destination action. Use generate_pdf when the user requests a PDF,
   invoice, proposal, report, or document; otherwise use http_request.
4. DO NOT include conversational text before or after the JSON.
5. If the prompt is too short, invent a logical 3-step automation for it.
6. Every step MUST include inputsRequired and config. Never omit config. When a config
   value does not apply, set endpoint, method, transformPrompt, and documentTemplate to null.
7. Every inputsRequired item MUST include key, label, type, placeholder, value, helpText,
   and howToGetIt. Use null when a value does not apply; never omit a property.

EXAMPLE EXPECTED OUTPUT:
{
  "workflowName": "Email to Slack",
  "summary": "Forwards incoming emails to a Slack channel using AI.",
  "steps": [
    {
      "id": "step-1",
      "type": "webhook_trigger",
      "title": "When an Email Arrives",
      "description": "Listens for new emails.",
      "inputsRequired": [
        {
          "key": "trigger_url",
          "label": "🔗 Your FlowPilot Listening Link",
          "type": "url",
          "placeholder": null,
          "value": null,
          "helpText": "This link lets FlowPilot know when an email arrives.",
          "howToGetIt": "1. Copy this link. 2. Paste it in your email forwarding settings. 3. Save your settings."
        }
      ],
      "config": {
        "endpoint": null,
        "method": null,
        "transformPrompt": null,
        "documentTemplate": null
      }
    },
    {
      "id": "step-2",
      "type": "ai_transform",
      "title": "AI Magic: Summarize Email",
      "description": "Summarizes the email content.",
      "inputsRequired": [
        {
          "key": "ai_prompt",
          "label": "AI Instructions",
          "type": "text",
          "placeholder": null,
          "value": null,
          "helpText": "Describe the kind of summary you want.",
          "howToGetIt": "1. Choose the summary length. 2. Choose the tone. 3. Write those instructions here."
        }
      ],
      "config": {
        "endpoint": null,
        "method": null,
        "transformPrompt": "Summarize the incoming email using the user's instructions.",
        "documentTemplate": null
      }
    },
    {
      "id": "step-3",
      "type": "http_request",
      "title": "Send to Slack",
      "description": "Pushes the summary to your channel.",
      "inputsRequired": [
        {
          "key": "slack_url",
          "label": "🔗 Slack Webhook URL",
          "type": "url",
          "placeholder": null,
          "value": null,
          "helpText": "This tells FlowPilot which Slack channel should receive the summary.",
          "howToGetIt": "1. Go to Slack API. 2. Create Webhook. 3. Paste here."
        }
      ],
      "config": {
        "endpoint": null,
        "method": "POST",
        "transformPrompt": null,
        "documentTemplate": null
      }
    }
  ]
}

You are also a beginner-friendly automation assistant.
Convert the user's request into exactly three core execution steps.

System Rules for Step Order:
1. STEP 1 must ALWAYS be the Trigger and use type webhook_trigger. This can fetch
   information such as trending topics, listen for a new event, or run on a schedule.
2. STEP 2 must ALWAYS be the AI Transformation or Generation and use type ai_transform.
3. STEP 3 must ALWAYS be the Destination Action. Use type generate_pdf for a PDF,
   invoice, proposal, report, or document. Otherwise use type http_request for sending
   to another app. A generate_pdf config must include a useful Markdown documentTemplate
   with variables such as {{trigger.name}}, {{trigger.query}}, and {{ai.summary}}.
NEVER place the Destination step before the AI Generation step.
Return exactly three steps in this exact order. Do not add a filter_condition step.

Give each step a unique stable id such as step_1. Never invent API credentials.
Only include endpoint URLs when they are implied by the request; placeholders are allowed.
Write every user-facing name, summary, title, description, label, hint, and guide in
simple everyday English that a first-time user will understand.
NEVER use technical jargon such as "Webhook", "API Key", "HTTP POST", "JSON", "payload",
"endpoint", "authentication token", or internal step type names in user-facing text.
For triggers that receive information, label the link "🔗 Your FlowPilot Listening Link".
For credentials, label them naturally for the destination, such as
"🔑 WhatsApp Security Key" rather than a technical credential name.
When a step needs information the user has not supplied, add a short, friendly field to
inputsRequired. Use secret for private security details, url for links, and text otherwise.
For every required input, always provide helpText that explains why it is needed and
howToGetIt containing exactly three short numbered steps. Explain where the person should
sign in, what they should click, and what they should copy or enter. Include the relevant
website address when it is known. Never assume the person has set up an integration before.
Make every label, placeholder, helpText, and howToGetIt specific to the user's actual topic.
Never mention email settings unless the user's request is actually about email.

For a YouTube script generator based on trending topics, always request exactly one detail
per step using these meanings:
- Step 1 asks "Where should FlowPilot check for trending topics?" and suggests
  https://trends.google.com/trends/rss or a news RSS feed.
- Step 2 asks for "AI Script Prompt Instructions" and suggests an engaging five-minute
  YouTube script with an introduction, three main points, and a call to action.
- Step 3 asks "Where should FlowPilot save or send your completed script?" and suggests
  an email address, Google Doc link, or Notion connection link.
Return an empty inputsRequired array when a step already has everything it needs.
Use null for configuration values that do not apply to a step.`,
      prompt: normalizedPrompt,
      temperature: 0,
      maxRetries: 2,
      providerOptions: {
        groq: {
          // llama-3.3 supports Groq's JSON object mode, while the AI SDK
          // performs the final Zod validation locally.
          structuredOutputs: false,
        },
      },
    });

    const wantsPdf = isPdfWorkflow(normalizedPrompt);
    const orderedSteps = [
      ...REQUIRED_STEP_ORDER.map((type) =>
        output.steps.find((step) => step.type === type),
      ),
      output.steps.find((step) =>
        wantsPdf
          ? step.type === "generate_pdf" || step.type === "http_request"
          : step.type === "http_request" || step.type === "generate_pdf",
      ),
    ];

    if (orderedSteps.some((step) => !step)) {
      throw new Error("The generated workflow did not contain the required step order.");
    }

    const youtubeWorkflow = isYouTubeScriptWorkflow(normalizedPrompt);
    const publicForm = createPublicFormDefinition(
      normalizedPrompt,
      output.workflowName,
      output.summary,
    );
    const compiledWorkflow = CompiledWorkflowSchema.parse({
      workflowName: output.workflowName,
      summary: output.summary,
      publicForm,
      dataTable: createDefaultDataTableDefinition(publicForm),
      steps: orderedSteps.map((orderedStep, stepIndex) => {
        const step = orderedStep!;
        const config = {
          ...(step.config.endpoint ? { endpoint: step.config.endpoint } : {}),
          ...(step.config.method ? { method: step.config.method } : {}),
          ...(step.config.transformPrompt
            ? { transformPrompt: step.config.transformPrompt }
            : {}),
          ...(stepIndex === 2 && wantsPdf
            ? {
                documentTemplate:
                  normalizeDocumentTemplate(
                    step.config.documentTemplate,
                    output.workflowName,
                  ),
              }
            : {}),
        };

        const inputsRequired = stepIndex === 2 && wantsPdf
          ? []
          : youtubeWorkflow
            ? youtubeScriptInput(stepIndex)
            : step.inputsRequired.map((input) => ({
              key: input.key,
              label: input.label,
              type: input.type,
              ...(input.placeholder ? { placeholder: input.placeholder } : {}),
              ...(input.value ? { value: input.value } : {}),
              ...(input.helpText ? { helpText: input.helpText } : {}),
              ...(input.howToGetIt ? { howToGetIt: input.howToGetIt } : {}),
              }));

        return {
          id: `step_${stepIndex + 1}`,
          type:
            stepIndex === 2
              ? wantsPdf
                ? "generate_pdf"
                : "http_request"
              : step.type,
          title: step.title,
          description: step.description,
          ...(inputsRequired.length > 0 ? { inputsRequired } : {}),
          ...(Object.keys(config).length > 0 ? { config } : {}),
        };
      }),
    });
    const workflowValues = {
      user_id: auth.user.id,
      name: compiledWorkflow.workflowName.slice(0, 80),
      prompt: normalizedPrompt,
      compiled_steps: compiledWorkflow,
    };
    const writeQuery = parsedExistingWorkflowId?.success
      ? auth.supabase
          .from("workflows")
          .update(workflowValues)
          .eq("id", parsedExistingWorkflowId.data)
          .eq("user_id", auth.user.id)
      : auth.supabase.from("workflows").insert(workflowValues);
    const { data, error } = await writeQuery.select("id").single();

    if (error) {
      console.error("Supabase compiled workflow insert failed", {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
      return {
        success: false,
        error: "The workflow compiled, but it could not be saved to the database.",
      };
    }

    if (!data?.id) {
      return {
        success: false,
        error: "The workflow was saved without an identifier.",
      };
    }

    return { success: true, id: data.id, workflow: compiledWorkflow };
  } catch (error: unknown) {
    console.error("🔥 AI Compiler Error Details:", error);
    const rawFailedOutput = getRawFailedModelOutput(error);
    if (rawFailedOutput !== undefined) {
      console.error(
        "🚨 RAW LLM OUTPUT THAT BROKE THE PARSER:",
        rawFailedOutput,
      );
    }
    return {
      success: false,
      error:
        "Failed to generate workflow. The AI returned invalid formatting. Please try again.",
    };
  }
}

export async function getWorkflow(workflowId: string): Promise<GetWorkflowResult> {
  const parsedWorkflowId = z.string().uuid().safeParse(workflowId);

  if (!parsedWorkflowId.success) {
    return { ok: false, error: "We could not find this automation." };
  }

  const auth = await getAuthenticatedContext();
  if (!auth) return { ok: false, error: "Unauthorized" };

  const { data, error } = await auth.supabase
    .from("workflows")
    .select("name, prompt, compiled_steps")
    .eq("id", parsedWorkflowId.data)
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (error || !data) {
    return { ok: false, error: "We could not find this automation." };
  }

  if (data.compiled_steps === null) {
    return {
      ok: true,
      workflow: null,
      name: data.name,
      prompt: data.prompt,
    };
  }

  const parsedWorkflow = CompiledWorkflowSchema.safeParse(data.compiled_steps);

  if (!parsedWorkflow.success) {
    console.error("Saved workflow could not be read", parsedWorkflow.error);
    return { ok: false, error: "This automation needs to be created again." };
  }

  return {
    ok: true,
    workflow: parsedWorkflow.data,
    name: data.name,
    prompt: data.prompt,
  };
}
