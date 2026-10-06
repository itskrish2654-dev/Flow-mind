/** Self-directed Slack questions must not be answered from messages mentioning another person. */
export function slackQuestionTargetsConnectedUser(question: string): boolean {
  return /\b(?:ask(?:ed|s)?|mention(?:ed|s)?)\s+me\b|\bmy\s+(?:review|approval|response|work item|attention)\b/i.test(question);
}

export function personalSlackMessages<T extends { message_text: string }>(
  messages: readonly T[],
  question: string,
  installingUserId: unknown,
): T[] {
  if (!slackQuestionTargetsConnectedUser(question)) return [...messages];
  if (typeof installingUserId !== "string" || !/^[UW][A-Z0-9]{7,20}$/.test(installingUserId)) return [];
  return messages.filter((message) => message.message_text.includes(`<@${installingUserId}>`));
}
