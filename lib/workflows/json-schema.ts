import type { WorkflowJsonSchema } from "./types";

export function schemaInstruction(schema: WorkflowJsonSchema): string {
  return [
    "Return ONLY valid JSON matching this JSON Schema. Do not wrap it in markdown.",
    JSON.stringify(schema),
  ].join("\n");
}

function typeOfJsonValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

export function validateJsonSchema(
  value: unknown,
  schema: WorkflowJsonSchema,
  pathName = "$"
): string[] {
  const errors: string[] = [];
  const type = schema.type;
  if (typeof type === "string") {
    const actual = typeOfJsonValue(value);
    const ok =
      type === actual ||
      (type === "integer" && typeof value === "number" && Number.isInteger(value)) ||
      (type === "number" && typeof value === "number");
    if (!ok) errors.push(`${pathName} expected ${type}, got ${actual}`);
  }
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && !enumValues.some((item) => Object.is(item, value))) {
    errors.push(`${pathName} must be one of schema.enum`);
  }
  if (schema.const !== undefined && !Object.is(schema.const, value)) {
    errors.push(`${pathName} must equal schema.const`);
  }
  if (
    schema.type === "object" ||
    (schema.properties && value && typeof value === "object" && !Array.isArray(value))
  ) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${pathName} expected object`);
      return errors;
    }
    const rec = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in rec)) {
        errors.push(`${pathName}.${key} is required`);
      }
    }
    const properties = schema.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [key, childSchema] of Object.entries(properties)) {
        if (key in rec && childSchema && typeof childSchema === "object") {
          errors.push(
            ...validateJsonSchema(
              rec[key],
              childSchema as WorkflowJsonSchema,
              `${pathName}.${key}`
            )
          );
        }
      }
    }
  }
  if (schema.type === "array" || (schema.items && Array.isArray(value))) {
    if (!Array.isArray(value)) {
      errors.push(`${pathName} expected array`);
      return errors;
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${pathName} expected at least ${schema.minItems} item(s)`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${pathName} expected at most ${schema.maxItems} item(s)`);
    }
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      value.forEach((item, index) => {
        errors.push(
          ...validateJsonSchema(
            item,
            schema.items as WorkflowJsonSchema,
            `${pathName}[${index}]`
          )
        );
      });
    }
  }
  return errors;
}
