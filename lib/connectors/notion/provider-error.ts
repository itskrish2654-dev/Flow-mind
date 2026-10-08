import { classifyConnectorHttpFailure } from "@/lib/connectors/errors";

/** Provider text is used only to select a safe, actionable category; never echo it. */
export function notionHttpFailure(status: number, body: unknown, retryAfter?: string | null) {
  const details = classifyConnectorHttpFailure(status, retryAfter);
  const response = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const code = typeof response.code === "string" && /^[a-z][a-z0-9_]{0,48}$/i.test(response.code)
    ? `NOTION_${response.code.toUpperCase()}` : details.code;
  if (status !== 400) return { ...details, code };

  const reason = typeof response.message === "string" ? response.message.slice(0, 1_000).toLowerCase() : "";
  const guidance = /permission|capabilit|access denied/.test(reason)
    ? "Notion denied this content change. Check that the selected resource is shared with the connection and the required content capability is enabled."
    : /parent|data.source|database/.test(reason)
      ? "Notion did not accept the selected parent or data source. Choose a recognizable shared data source with a verified containing database."
      : /propert|field|title|select|date|rich.text/.test(reason)
        ? "Notion did not accept one or more item fields. Review the selected data source's property names, types, and required title."
        : "Notion did not accept this request. Review the selected data source and exact item fields before creating a new approval.";
  return { ...details, code, message: guidance };
}
