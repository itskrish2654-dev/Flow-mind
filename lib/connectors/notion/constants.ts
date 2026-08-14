// Current official API pin verified during Phase 7B-2. It retains the
// first-class data_sources model introduced in the 2025 API.
export const NOTION_API_VERSION = "2026-03-11";
export const NOTION_AUTHORIZATION_URL = "https://api.notion.com/v1/oauth/authorize";
export const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

export const NOTION_CAPABILITIES = {
  readContent: "content:read",
  insertContent: "content:insert",
  updateContent: "content:update",
} as const;
