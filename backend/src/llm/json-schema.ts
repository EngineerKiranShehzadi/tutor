import type { LlmSchema } from './llm.types';

export type JsonSchema = Record<string, unknown>;

// The one place LlmSchema is mapped onto JSON Schema, for the providers that
// take JSON Schema (OpenAI): lower-case types, every object closed
// (additionalProperties: false).
//
// strict: true produces what OpenAI's strict Structured Outputs requires:
// EVERY property listed in `required`. A property the LlmSchema leaves
// optional becomes required-but-nullable instead (its type gains "null", and
// an enum gains null), which is how strict mode spells "may be absent". The
// parsers already treat null like a missing field (e.g. the adaptive planner's
// retrievalQuery on a STOP decision). Without strict, `required` is passed
// through as written.
export function toJsonSchema(schema: LlmSchema, opts: { strict?: boolean } = {}): JsonSchema {
  const typeMap: Record<LlmSchema['type'], string> = { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean', OBJECT: 'object', ARRAY: 'array' };
  const out: JsonSchema = { type: typeMap[schema.type] };
  if (schema.description !== undefined) out.description = schema.description;
  if (schema.enum !== undefined) out.enum = schema.enum;
  if (schema.items !== undefined) out.items = toJsonSchema(schema.items, opts);
  if (schema.properties !== undefined) {
    const keys = Object.keys(schema.properties);
    const required = new Set(schema.required ?? []);
    out.properties = Object.fromEntries(keys.map(k => {
      const prop = toJsonSchema(schema.properties![k], opts);
      return [k, opts.strict && !required.has(k) ? nullable(prop) : prop];
    }));
    out.additionalProperties = false;
    if (opts.strict) out.required = keys;
    else if (schema.required !== undefined) out.required = schema.required;
  } else if (schema.required !== undefined && !opts.strict) {
    out.required = schema.required;
  }
  return out;
}

const nullable = (prop: JsonSchema): JsonSchema => ({
  ...prop,
  type: [prop.type as string, 'null'],
  ...(Array.isArray(prop.enum) ? { enum: [...prop.enum, null] } : {}),
});
