export const FORMATTER_OPERATIONS = [
  "trim",
  "uppercase",
  "lowercase",
  "title_case",
  "replace",
  "split",
  "join",
  "prepend",
  "append",
  "add",
  "subtract",
  "multiply",
  "divide",
  "round",
  "format_date",
  "add_duration",
  "subtract_duration",
  "convert_timezone",
  "default_value",
  "first_non_empty",
] as const;

export type FormatterOperation = (typeof FORMATTER_OPERATIONS)[number];

export const FORMATTER_ERROR_CODES = [
  "FORMATTER_INVALID_INPUT",
  "FORMATTER_INVALID_NUMBER",
  "FORMATTER_DIVISION_BY_ZERO",
  "FORMATTER_INVALID_DATE",
  "FORMATTER_TIMEZONE_REQUIRED",
  "FORMATTER_OUTPUT_TOO_LARGE",
] as const;

export type FormatterErrorCode = (typeof FORMATTER_ERROR_CODES)[number];

export type FormatterConfig = {
  version: 1;
  operation: FormatterOperation;
  source: FormatterSource;
  sources?: FormatterSource[];
  outputKey: string;
  find?: string;
  replacement?: string;
  separator?: string;
  value?: unknown;
  operand?: number;
  decimalPlaces?: number;
  dateFormat?: string;
  timezone?: string;
  durationAmount?: number;
  durationUnit?: "minutes" | "hours" | "days";
};

export type FormatterSource = {
  kind: "trigger" | "step" | "literal" | "ai";
  path?: string;
  stepId?: string;
  value?: unknown;
};

export class FormatterError extends Error {
  readonly retryable = false;

  constructor(readonly code: FormatterErrorCode, message: string) {
    super(message);
    this.name = "FormatterError";
  }
}

const MAX_INPUT_BYTES = 32_768;
const MAX_OUTPUT_BYTES = 32_768;
const MAX_COLLECTION_ITEMS = 1_000;
const MAX_NUMBER_MAGNITUDE = 1_000_000_000_000_000;
const MAX_DURATION_AMOUNT = 5_256_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

function byteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return 0;
  return new TextEncoder().encode(serialized).length;
}

function assertBoundedInput(value: unknown): void {
  if (byteLength(value) > MAX_INPUT_BYTES) {
    throw new FormatterError("FORMATTER_INVALID_INPUT", "Formatter input is too large.");
  }
  if (Array.isArray(value) && value.length > MAX_COLLECTION_ITEMS) {
    throw new FormatterError("FORMATTER_INVALID_INPUT", "Formatter input contains too many items.");
  }
}

function assertBoundedOutput<T>(value: T): T {
  if (Array.isArray(value) && value.length > MAX_COLLECTION_ITEMS) {
    throw new FormatterError("FORMATTER_OUTPUT_TOO_LARGE", "Formatter output contains too many items.");
  }
  if (byteLength(value) > MAX_OUTPUT_BYTES) {
    throw new FormatterError("FORMATTER_OUTPUT_TOO_LARGE", "Formatter output is too large.");
  }
  return value;
}

function requireText(value: unknown): string {
  if (typeof value !== "string") {
    throw new FormatterError("FORMATTER_INVALID_INPUT", "This formatter operation requires text input.");
  }
  return value;
}

function parseNumber(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_NUMBER_MAGNITUDE) {
      throw new FormatterError("FORMATTER_INVALID_NUMBER", "The formatter received an invalid number.");
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new FormatterError("FORMATTER_INVALID_NUMBER", "The formatter received an invalid number.");
  }
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) {
    throw new FormatterError("FORMATTER_INVALID_NUMBER", "The formatter received an invalid number.");
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > MAX_NUMBER_MAGNITUDE) {
    throw new FormatterError("FORMATTER_INVALID_NUMBER", "The formatter received an invalid number.");
  }
  return parsed;
}

function checkedNumber(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_NUMBER_MAGNITUDE) {
    throw new FormatterError("FORMATTER_INVALID_NUMBER", "The formatter result is outside the supported numeric range.");
  }
  return Object.is(value, -0) ? 0 : value;
}

function parseDate(value: unknown): Date {
  if (typeof value !== "string" || (!ISO_DATE.test(value) && !ISO_DATE_TIME.test(value))) {
    throw new FormatterError("FORMATTER_INVALID_DATE", "Use an ISO date or an ISO timestamp with a timezone offset.");
  }
  const date = new Date(ISO_DATE.test(value) ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) {
    throw new FormatterError("FORMATTER_INVALID_DATE", "The formatter received an invalid date.");
  }
  return date;
}

function validateTimezone(timezone: string | undefined, required: boolean): string {
  if (!timezone) {
    if (required) {
      throw new FormatterError("FORMATTER_TIMEZONE_REQUIRED", "Choose an IANA timezone for this formatter operation.");
    }
    return "UTC";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new FormatterError("FORMATTER_TIMEZONE_REQUIRED", "Choose a valid IANA timezone for this formatter operation.");
  }
  return timezone;
}

function dateParts(date: Date, timezone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function formatDate(date: Date, format: string, timezone: string): string {
  if (!/^(?=.*(?:YYYY|MM|DD|HH|mm|ss))(?:YYYY|MM|DD|HH|mm|ss|[\sT:/.,_-]){1,40}$/.test(format)) {
    throw new FormatterError("FORMATTER_INVALID_INPUT", "The date format contains unsupported tokens.");
  }
  const parts = dateParts(date, timezone);
  const values: Record<string, string> = {
    YYYY: parts.year,
    MM: parts.month,
    DD: parts.day,
    HH: parts.hour,
    mm: parts.minute,
    ss: parts.second,
  };
  return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => values[token]);
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function titleCase(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/\p{L}[\p{L}\p{M}'’-]*/gu, (word) => {
    const [first, ...rest] = Array.from(word);
    return `${first?.toLocaleUpperCase("en-US") ?? ""}${rest.join("")}`;
  });
}

function durationMilliseconds(config: FormatterConfig): number {
  const amount = config.durationAmount;
  if (!Number.isInteger(amount) || amount === undefined || Math.abs(amount) > MAX_DURATION_AMOUNT) {
    throw new FormatterError("FORMATTER_INVALID_INPUT", "Duration must be a bounded whole number.");
  }
  const unit = config.durationUnit;
  const multiplier = unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : unit === "days" ? 86_400_000 : 0;
  if (!multiplier) {
    throw new FormatterError("FORMATTER_INVALID_INPUT", "Choose minutes, hours, or days for the duration.");
  }
  return amount * multiplier;
}

export function executeFormatter(
  config: FormatterConfig,
  input: unknown,
  inputs: unknown[] = [],
): unknown {
  assertBoundedInput(input);
  for (const candidate of inputs) assertBoundedInput(candidate);

  let output: unknown;
  switch (config.operation) {
    case "trim": output = requireText(input).trim(); break;
    case "uppercase": output = requireText(input).toLocaleUpperCase("en-US"); break;
    case "lowercase": output = requireText(input).toLocaleLowerCase("en-US"); break;
    case "title_case": output = titleCase(requireText(input)); break;
    case "replace": {
      const find = config.find;
      if (!find) throw new FormatterError("FORMATTER_INVALID_INPUT", "Text to find is required for replace.");
      output = requireText(input).split(find).join(config.replacement ?? "");
      break;
    }
    case "split": {
      if (!config.separator) throw new FormatterError("FORMATTER_INVALID_INPUT", "A non-empty separator is required for split.");
      output = requireText(input).split(config.separator);
      break;
    }
    case "join": {
      if (!Array.isArray(input)) throw new FormatterError("FORMATTER_INVALID_INPUT", "Join requires a list input.");
      if (input.some((item) => !["string", "number", "boolean"].includes(typeof item))) {
        throw new FormatterError("FORMATTER_INVALID_INPUT", "Join supports only text, number, or boolean list items.");
      }
      output = input.join(config.separator ?? ", ");
      break;
    }
    case "prepend": output = `${String(config.value ?? "")}${requireText(input)}`; break;
    case "append": output = `${requireText(input)}${String(config.value ?? "")}`; break;
    case "add": output = checkedNumber(parseNumber(input) + parseNumber(config.operand)); break;
    case "subtract": output = checkedNumber(parseNumber(input) - parseNumber(config.operand)); break;
    case "multiply": output = checkedNumber(parseNumber(input) * parseNumber(config.operand)); break;
    case "divide": {
      const operand = parseNumber(config.operand);
      if (operand === 0) throw new FormatterError("FORMATTER_DIVISION_BY_ZERO", "The formatter cannot divide by zero.");
      output = checkedNumber(parseNumber(input) / operand);
      break;
    }
    case "round": {
      const places = config.decimalPlaces ?? 0;
      if (!Number.isInteger(places) || places < 0 || places > 12) {
        throw new FormatterError("FORMATTER_INVALID_INPUT", "Decimal places must be a whole number from 0 to 12.");
      }
      const number = parseNumber(input);
      const factor = 10 ** places;
      output = checkedNumber(Math.round((number + Math.sign(number) * Number.EPSILON) * factor) / factor);
      break;
    }
    case "format_date": {
      const timezone = validateTimezone(config.timezone, false);
      output = formatDate(parseDate(input), config.dateFormat ?? "YYYY-MM-DD", timezone);
      break;
    }
    case "add_duration":
    case "subtract_duration": {
      const date = parseDate(input);
      const direction = config.operation === "add_duration" ? 1 : -1;
      const shifted = new Date(date.getTime() + direction * durationMilliseconds(config));
      if (config.timezone) {
        const timezone = validateTimezone(config.timezone, true);
        output = `${formatDate(shifted, "YYYY-MM-DD HH:mm:ss", timezone)} ${timezone}`;
      } else {
        output = shifted.toISOString();
      }
      break;
    }
    case "convert_timezone": {
      const timezone = validateTimezone(config.timezone, true);
      output = `${formatDate(parseDate(input), config.dateFormat ?? "YYYY-MM-DD HH:mm:ss", timezone)} ${timezone}`;
      break;
    }
    case "default_value": output = isEmpty(input) ? config.value ?? "" : input; break;
    case "first_non_empty": output = [input, ...inputs].find((candidate) => !isEmpty(candidate)) ?? config.value ?? ""; break;
    default: {
      const exhaustive: never = config.operation;
      throw new FormatterError("FORMATTER_INVALID_INPUT", `Unsupported formatter operation: ${exhaustive}`);
    }
  }

  return assertBoundedOutput(output);
}
