import "server-only";

export type PublicFormTrace = (
  checkpoint: string,
  details?: Record<string, string | number | boolean | null>,
) => void;

export function createPublicFormTrace(requestId: string): PublicFormTrace {
  const startedAt = performance.now();

  return (checkpoint, details = {}) => {
    console.info("FLOWMIND_PUBLIC_FORM", {
      requestId,
      checkpoint,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...details,
    });
  };
}
