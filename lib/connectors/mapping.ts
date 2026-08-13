import type { CommonValueType, ConnectorField } from "@/lib/connectors/types";

export type MappingSource =
  | { kind: "trigger"; path: string }
  | { kind: "step"; stepId: string; path: string }
  | { kind: "literal"; value: unknown }
  | { kind: "ai"; stepId: string; path?: string }
  | { kind: "fallback"; sources: MappingSource[] };

export type FieldMapping = { target: string; source: MappingSource };
export type MappingContext = {
  trigger: Record<string, unknown>;
  steps: Record<string, Record<string, unknown>>;
};

function readPath(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

export function resolveMappingSource(source: MappingSource, context: MappingContext): unknown {
  if (source.kind === "literal") return source.value;
  if (source.kind === "trigger") return readPath(context.trigger, source.path);
  if (source.kind === "step") return readPath(context.steps[source.stepId], source.path);
  if (source.kind === "ai") return readPath(context.steps[source.stepId], source.path ?? "result");
  for (const candidate of source.sources) {
    const value = resolveMappingSource(candidate, context);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function valueMatchesType(value: unknown, type: CommonValueType): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "email") return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (type === "url") { try { return typeof value === "string" && ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } }
  if (type === "datetime") return typeof value === "string" && !Number.isNaN(Date.parse(value));
  if (type === "object") return !!value && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  return value instanceof Uint8Array || Buffer.isBuffer(value);
}

export function applyFieldMappings(fields: ConnectorField[], mappings: FieldMapping[], context: MappingContext): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const mapping = mappings.find((item) => item.target === field.key);
    const value = mapping ? resolveMappingSource(mapping.source, context) : undefined;
    if (field.required && (value === undefined || value === null || value === "")) throw new Error(`${field.label} is required.`);
    if (value !== undefined && !valueMatchesType(value, field.type)) throw new Error(`${field.label} must be a valid ${field.type}.`);
    if (value !== undefined) result[field.key] = value;
  }
  return result;
}

export type AutoMappingResult = { mappings: FieldMapping[]; missing: string[]; uncertain: string[] };

export function autoMapFields(sourceFields: ConnectorField[], targetFields: ConnectorField[]): AutoMappingResult {
  const mappings: FieldMapping[] = [];
  const missing: string[] = [];
  const uncertain: string[] = [];
  for (const target of targetFields) {
    const exact = sourceFields.find((source) => source.key === target.key && source.type === target.type);
    const label = sourceFields.find((source) => source.label.toLowerCase() === target.label.toLowerCase() && source.type === target.type);
    const match = exact ?? label;
    if (match) mappings.push({ target: target.key, source: { kind: "trigger", path: match.key } });
    else if (target.required) missing.push(target.key);
    else uncertain.push(target.key);
  }
  return { mappings, missing, uncertain };
}
