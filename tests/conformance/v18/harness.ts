// Minimal JSON Schema 2020-12 subset validator scoped to the
// `json_envelope.v1` shape. This is intentionally hand-rolled so the
// spec → code mapping stays visible (one block per JSON Schema keyword
// we actually consume) rather than hidden inside a transitive Ajv
// install we do not declare.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const PLAN_BUNDLE_DIR = path.resolve(
  moduleDir,
  "../../../PLAN/oracle-vnext-plan-bundle-v18.0.0",
);

export interface JsonEnvelopeSchema {
  $id?: string;
  type: "object";
  required: string[];
  additionalProperties: boolean;
  properties: Record<string, PropertyConstraint>;
}

interface PropertyConstraint {
  type?: string | string[];
  items?: { type?: string | string[] };
}

export async function loadJsonEnvelopeSchema(): Promise<JsonEnvelopeSchema> {
  const schemaPath = path.join(PLAN_BUNDLE_DIR, "contracts/json-envelope.schema.json");
  const raw = await readFile(schemaPath, "utf8");
  const parsed = JSON.parse(raw) as JsonEnvelopeSchema;
  if (parsed.type !== "object") {
    throw new Error(`Unexpected envelope schema type: ${String(parsed.type)}`);
  }
  return parsed;
}

export async function loadOkFixture(): Promise<Record<string, unknown>> {
  const fixturePath = path.join(PLAN_BUNDLE_DIR, "fixtures/json-envelope.ok.json");
  return JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
}

export interface ValidationFailure {
  pointer: string;
  message: string;
}

export function validateEnvelope(
  value: unknown,
  schema: JsonEnvelopeSchema,
): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  if (!isObject(value)) {
    failures.push({ pointer: "", message: "envelope must be a JSON object" });
    return failures;
  }
  for (const required of schema.required) {
    if (!(required in value)) {
      failures.push({ pointer: `/${required}`, message: "missing required field" });
    }
  }
  for (const [key, constraint] of Object.entries(schema.properties)) {
    if (!(key in value)) continue;
    const fieldValue = (value as Record<string, unknown>)[key];
    if (constraint.type !== undefined && !matchesType(fieldValue, constraint.type)) {
      failures.push({
        pointer: `/${key}`,
        message: `expected type ${describeType(constraint.type)}, got ${describeRuntimeType(fieldValue)}`,
      });
      continue;
    }
    if (constraint.items && Array.isArray(fieldValue)) {
      const itemType = constraint.items.type;
      if (itemType !== undefined) {
        fieldValue.forEach((entry, index) => {
          if (!matchesType(entry, itemType)) {
            failures.push({
              pointer: `/${key}/${index}`,
              message: `expected item type ${describeType(itemType)}, got ${describeRuntimeType(entry)}`,
            });
          }
        });
      }
    }
  }
  return failures;
}

export function isValid(value: unknown, schema: JsonEnvelopeSchema): boolean {
  return validateEnvelope(value, schema).length === 0;
}

function matchesType(value: unknown, type: string | string[]): boolean {
  const allowed = Array.isArray(type) ? type : [type];
  return allowed.some((t) => matchesSingleType(value, t));
}

function matchesSingleType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      return false;
  }
}

function describeType(type: string | string[]): string {
  return Array.isArray(type) ? type.join(" | ") : type;
}

function describeRuntimeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
