const ALLOWED_PREFIXES = ["/dashboard", "/settings", "/my-day", "/ask", "/connections", "/knowledge"];

export function safeAuthReturnPath(value: string | string[] | null | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) return "/dashboard";
  try {
    const parsed = new URL(candidate, "https://crazyloops.invalid");
    if (parsed.origin !== "https://crazyloops.invalid" || parsed.hash) return "/dashboard";
    if (ALLOWED_PREFIXES.some((prefix) => parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`))) {
      return `${parsed.pathname}${parsed.search}`;
    }
    if (parsed.pathname === "/invite/accept" && parsed.searchParams.has("token")) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    return "/dashboard";
  }
  return "/dashboard";
}
