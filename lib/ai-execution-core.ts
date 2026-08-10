export type AiProviderResult = {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
};

export type AiExecutionMetadata = {
  provider: string;
  model: string;
  durationMs: number;
  inputCharacters: number;
  outputCharacters: number;
  maxOutputTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
};

export class AiExecutionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "AI_NOT_CONFIGURED"
      | "AI_INPUT_TOO_LARGE"
      | "AI_TIMEOUT"
      | "AI_PROVIDER_FAILED"
      | "AI_EMPTY_OUTPUT",
  ) {
    super(message);
    this.name = "AiExecutionError";
  }
}

export type AiTextExecutor = (input: {
  instruction: string;
  content: string;
}) => Promise<{ text: string; metadata: AiExecutionMetadata }>;

export function createAiTextExecutor({
  provider,
  model,
  timeoutMs,
  maxInputCharacters,
  maxOutputTokens,
  runModel,
}: {
  provider: string;
  model: string;
  timeoutMs: number;
  maxInputCharacters: number;
  maxOutputTokens: number;
  runModel: (input: {
    instruction: string;
    content: string;
    signal: AbortSignal;
    maxOutputTokens: number;
  }) => Promise<AiProviderResult>;
}): AiTextExecutor {
  return async ({ instruction, content }) => {
    const combinedLength = instruction.length + content.length;
    if (combinedLength > maxInputCharacters) {
      throw new AiExecutionError(
        `AI input exceeds the ${maxInputCharacters.toLocaleString()} character limit.`,
        "AI_INPUT_TOO_LARGE",
      );
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(
          new AiExecutionError(
            `AI execution timed out after ${timeoutMs.toLocaleString()} ms.`,
            "AI_TIMEOUT",
          ),
        );
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        runModel({
          instruction,
          content,
          signal: controller.signal,
          maxOutputTokens,
        }),
        timeoutPromise,
      ]);
      const text = result.text.trim();
      if (!text) {
        throw new AiExecutionError(
          "The AI provider returned an empty result.",
          "AI_EMPTY_OUTPUT",
        );
      }
      return {
        text,
        metadata: {
          provider,
          model,
          durationMs: Date.now() - startedAt,
          inputCharacters: combinedLength,
          outputCharacters: text.length,
          maxOutputTokens,
          inputTokens: result.inputTokens ?? null,
          outputTokens: result.outputTokens ?? null,
        },
      };
    } catch (error: unknown) {
      if (error instanceof AiExecutionError) throw error;
      if (timedOut || controller.signal.aborted) {
        throw new AiExecutionError(
          `AI execution timed out after ${timeoutMs.toLocaleString()} ms.`,
          "AI_TIMEOUT",
        );
      }
      throw new AiExecutionError(
        "The AI provider could not complete this step.",
        "AI_PROVIDER_FAILED",
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
}
