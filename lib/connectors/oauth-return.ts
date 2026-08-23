const PROJECT_RETURN_PATH = /^\/dashboard\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export function safeOAuthReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/connections";
  }
  try {
    const parsed = new URL(value, "https://crazyloops.invalid");
    if (parsed.origin !== "https://crazyloops.invalid") return "/connections";
    if (["/connections", "/dashboard", "/settings/connections"].includes(parsed.pathname)) {
      return parsed.pathname;
    }
    if (!PROJECT_RETURN_PATH.test(parsed.pathname)) return "/connections";
    const stepId = parsed.searchParams.get("step")?.trim();
    return stepId && /^[A-Za-z0-9_-]{1,100}$/.test(stepId)
      ? `${parsed.pathname}?step=${encodeURIComponent(stepId)}`
      : parsed.pathname;
  } catch {
    return "/connections";
  }
}

export function oauthReturnWorkflowId(returnPath: string): string | null {
  const parsed = new URL(safeOAuthReturnPath(returnPath), "https://crazyloops.invalid");
  return PROJECT_RETURN_PATH.exec(parsed.pathname)?.[1] ?? null;
}

export function withOAuthResult(
  returnPath: string,
  key: "connected" | "connection_error",
  value: string,
): string {
  const parsed = new URL(safeOAuthReturnPath(returnPath), "https://crazyloops.invalid");
  parsed.searchParams.set(key, value.slice(0, 80));
  return `${parsed.pathname}${parsed.search}`;
}
