import type { CompiledWorkflow } from "@/lib/schemas/workflow";

export type ConditionDefinition = NonNullable<
  NonNullable<CompiledWorkflow["steps"][number]["config"]>["condition"]
>;

function valueAtPath(context: Record<string, unknown>, path: string): unknown {
  const direct = context[path];
  if (direct !== undefined) return direct;
  return path.split(".").filter(Boolean).reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, context);
}

export function evaluateCondition(
  condition: ConditionDefinition,
  context: Record<string, unknown>,
): { matched: boolean; actualValue: unknown } {
  const actualValue = valueAtPath(context, condition.sourcePath);
  const expected = condition.expectedValue;
  const normalizedActual = typeof actualValue === "string" ? actualValue.trim() : actualValue;
  const normalizedExpected = typeof expected === "string" ? expected.trim() : expected;
  let matched: boolean;
  switch (condition.operator) {
    case "exists": matched = actualValue !== undefined && actualValue !== null && actualValue !== ""; break;
    case "not_exists": matched = actualValue === undefined || actualValue === null || actualValue === ""; break;
    case "is_true": matched = actualValue === true || String(actualValue).toLowerCase() === "true"; break;
    case "is_false": matched = actualValue === false || String(actualValue).toLowerCase() === "false"; break;
    case "greater_than": matched = Number(actualValue) > Number(expected); break;
    case "less_than": matched = Number(actualValue) < Number(expected); break;
    case "contains": matched = String(normalizedActual ?? "").toLowerCase().includes(String(normalizedExpected ?? "").toLowerCase()); break;
    case "not_contains": matched = !String(normalizedActual ?? "").toLowerCase().includes(String(normalizedExpected ?? "").toLowerCase()); break;
    case "not_equals": matched = String(normalizedActual ?? "").toLowerCase() !== String(normalizedExpected ?? "").toLowerCase(); break;
    case "equals": matched = typeof expected === "number" ? Number(actualValue) === expected : String(normalizedActual ?? "").toLowerCase() === String(normalizedExpected ?? "").toLowerCase(); break;
  }
  return { matched, actualValue };
}
