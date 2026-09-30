const HARMLESS_ARTICLES = new Set(["a", "an", "the"]);

export const FALSE_APPROVAL_STATE_PATTERN =
  /\b(?:already approved|has been approved|was approved|approved the|already rejected|has been rejected|was rejected|executed)\b/i;

export const FALSE_EXTERNAL_DELIVERY_PATTERN =
  /\b(?:email (?:was|has been) sent|sent (?:an|the) email|delivered (?:an|the) email|completed the email)\b/i;

export const SPECIFIC_DATE_PATTERN =
  /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?))\b/i;

export const WRONG_WAITING_STATUS_PATTERN =
  /\b(?:done|completed|resolved)\b|\bneeds?\s+(?:your\s+)?(?:attention|action)\b|\baction required\b/i;

const UNSUPPORTED_DEPENDENCY_PATTERNS = [
  /\bblocks?\b/,
  /\b(?:depends? on|dependent on|prerequisite)\b/,
  /\b(?:must|needs? to|has to|required to)\b.{0,80}\bbefore\b/,
  /\bbefore\b.{0,80}\bcan\b.{0,80}\b(?:finalized|completed|proceed|start|begin)\b/,
  /\b(?:cannot|can t|unable to)\b.{0,100}\buntil\b/,
  /\bonly after\b/,
] as const;

const EXPLICIT_DEPENDENCY_DENIAL =
  /\b(?:no|not|without)\b.{0,40}\b(?:dependency|blocker|prerequisite|depend|block)\b|\b(?:does not|do not|is not|are not)\b.{0,30}\b(?:depend|block|require)\b/;

export function containsUnsupportedDependencyClaim(value: string): boolean {
  return value
    .slice(0, 8_000)
    .split(/[.!?;]+/u)
    .map(normalizeAskDisplayText)
    .filter((clause) => clause && !EXPLICIT_DEPENDENCY_DENIAL.test(clause))
    .some((clause) => UNSUPPORTED_DEPENDENCY_PATTERNS.some((pattern) => pattern.test(clause)));
}

export function normalizeAskDisplayText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-GB")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .filter((word) => !HARMLESS_ARTICLES.has(word))
    .join(" ");
}

export function containsMaterialPhrase(value: string, phrase: string): boolean {
  const normalizedValue = ` ${normalizeAskDisplayText(value)} `;
  const normalizedPhrase = normalizeAskDisplayText(phrase);
  return normalizedPhrase.length > 0 && normalizedValue.includes(` ${normalizedPhrase} `);
}

export function containsAnyMaterialPhrase(value: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => containsMaterialPhrase(value, phrase));
}

type AskReference = {
  kind?: string;
  label?: string;
  entityId?: string;
};

export function hasStructuredReference(
  references: readonly AskReference[] | null | undefined,
  expected: { kind: string; label: string; entityId?: string },
): boolean {
  return (references ?? []).some((reference) =>
    reference.kind === expected.kind
    && reference.label === expected.label
    && (expected.entityId === undefined || reference.entityId === expected.entityId));
}

export type AskTurnObservation =
  | { kind: "completed" }
  | { kind: "failed"; failureCategory: string | null }
  | { kind: "processing" };

export function classifyAskTurnObservation(
  state: string | null | undefined,
  assistantPresent: boolean,
  failureCategory: string | null | undefined,
): AskTurnObservation {
  if (state === "failed") {
    return { kind: "failed", failureCategory: failureCategory ?? null };
  }
  if (state === "completed" && assistantPresent) {
    return { kind: "completed" };
  }
  return { kind: "processing" };
}
