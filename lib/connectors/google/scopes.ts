export const GOOGLE_IDENTITY_SCOPES = ["openid", "email"] as const;

export const GOOGLE_SCOPES = {
  gmailReadonly: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  driveFile: "https://www.googleapis.com/auth/drive.file",
  calendarListReadonly: "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  calendarEventsOwned: "https://www.googleapis.com/auth/calendar.events.owned",
} as const;

export const GOOGLE_LEGACY_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export type GoogleOperationScopeInventory = {
  connector: "Gmail" | "Google Sheets" | "Google Calendar";
  operation: string;
  scope: string;
  why: string;
  classification: "identity" | "non_sensitive" | "sensitive" | "restricted";
  verificationRequired: boolean;
};

export const GOOGLE_SCOPE_INVENTORY: GoogleOperationScopeInventory[] = [
  { connector: "Gmail", operation: "new_email / new_email_matching_search", scope: GOOGLE_SCOPES.gmailReadonly, why: "Read changed messages and normalize their safe text and metadata.", classification: "restricted", verificationRequired: true },
  { connector: "Gmail", operation: "send_email", scope: GOOGLE_SCOPES.gmailSend, why: "Send an email only when a workflow explicitly contains the Gmail send action.", classification: "sensitive", verificationRequired: true },
  { connector: "Gmail", operation: "reply_to_email", scope: GOOGLE_SCOPES.gmailReadonly, why: "Read the referenced message headers required to preserve its thread.", classification: "restricted", verificationRequired: true },
  { connector: "Gmail", operation: "reply_to_email", scope: GOOGLE_SCOPES.gmailSend, why: "Send the acknowledged reply in the existing Gmail thread.", classification: "sensitive", verificationRequired: true },
  { connector: "Google Sheets", operation: "add_row / find_row / update_row", scope: GOOGLE_SCOPES.driveFile, why: "Read or write only spreadsheets explicitly selected through Google Picker.", classification: "non_sensitive", verificationRequired: false },
  { connector: "Google Calendar", operation: "list_calendars", scope: GOOGLE_SCOPES.calendarListReadonly, why: "List calendars available to the connected account.", classification: "sensitive", verificationRequired: true },
  { connector: "Google Calendar", operation: "read_events / create_event / update_event", scope: GOOGLE_SCOPES.calendarEventsOwned, why: "Read and change events only on calendars owned by the connected account.", classification: "sensitive", verificationRequired: true },
];

export function googleScopesForOperation(connectorId: string, operationKey?: string | null): string[] {
  const identity = [...GOOGLE_IDENTITY_SCOPES];
  if (connectorId === "google_gmail") {
    if (operationKey === "send_email") return [...identity, GOOGLE_SCOPES.gmailSend];
    if (operationKey === "reply_to_email") return [...identity, GOOGLE_SCOPES.gmailReadonly, GOOGLE_SCOPES.gmailSend];
    return [...identity, GOOGLE_SCOPES.gmailReadonly];
  }
  if (connectorId === "google_sheets") return [...identity, GOOGLE_SCOPES.driveFile];
  if (connectorId === "google_calendar") return [...identity, GOOGLE_SCOPES.calendarListReadonly, GOOGLE_SCOPES.calendarEventsOwned];
  return identity;
}
