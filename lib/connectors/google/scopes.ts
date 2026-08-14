export const GOOGLE_IDENTITY_SCOPES = ["openid", "email"] as const;

export const GOOGLE_SCOPES = {
  gmailReadonly: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  sheets: "https://www.googleapis.com/auth/spreadsheets",
} as const;

export type GoogleOperationScopeInventory = {
  connector: "Gmail" | "Google Sheets";
  operation: string;
  scope: string;
  why: string;
  classification: "identity" | "sensitive" | "restricted";
  verificationRequired: boolean;
};

export const GOOGLE_SCOPE_INVENTORY: GoogleOperationScopeInventory[] = [
  { connector: "Gmail", operation: "new_email / new_email_matching_search", scope: GOOGLE_SCOPES.gmailReadonly, why: "Read changed messages and normalize their safe text and metadata.", classification: "restricted", verificationRequired: true },
  { connector: "Gmail", operation: "send_email", scope: GOOGLE_SCOPES.gmailSend, why: "Send an email only when a workflow explicitly contains the Gmail send action.", classification: "sensitive", verificationRequired: true },
  { connector: "Gmail", operation: "reply_to_email", scope: GOOGLE_SCOPES.gmailReadonly, why: "Read the referenced message headers required to preserve its thread.", classification: "restricted", verificationRequired: true },
  { connector: "Gmail", operation: "reply_to_email", scope: GOOGLE_SCOPES.gmailSend, why: "Send the acknowledged reply in the existing Gmail thread.", classification: "sensitive", verificationRequired: true },
  { connector: "Google Sheets", operation: "add_row / find_row / update_row", scope: GOOGLE_SCOPES.sheets, why: "Read the selected worksheet schema and read or write only the configured spreadsheet.", classification: "sensitive", verificationRequired: true },
];

export function googleScopesForOperation(connectorId: string, operationKey?: string | null): string[] {
  const identity = [...GOOGLE_IDENTITY_SCOPES];
  if (connectorId === "google_gmail") {
    if (operationKey === "send_email") return [...identity, GOOGLE_SCOPES.gmailSend];
    if (operationKey === "reply_to_email") return [...identity, GOOGLE_SCOPES.gmailReadonly, GOOGLE_SCOPES.gmailSend];
    return [...identity, GOOGLE_SCOPES.gmailReadonly];
  }
  if (connectorId === "google_sheets") return [...identity, GOOGLE_SCOPES.sheets];
  return identity;
}

