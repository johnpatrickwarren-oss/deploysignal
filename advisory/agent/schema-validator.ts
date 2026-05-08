// advisory/agent/schema-validator.ts — minimal JSON Schema Draft-07 subset.
//
// Advisory-local duplicate of the hand-rolled validator in
// `tools/profile-loader.ts` (#28). Kept local so `advisory/agent/`
// doesn't depend on tools/ at compile time (tests compile under
// `tsconfig.test.json` which includes tools/*; runtime under
// `tsconfig.json` excludes tools/ via its `exclude` list).
//
// Covers the subset of Draft-07 used by the playbook + ProposedAction
// schemas: type, enum, pattern, required, additionalProperties,
// properties, items, minLength, minimum, maximum, exclusiveMinimum.

export interface SchemaNode {
  type?: string | string[];
  enum?: unknown[];
  pattern?: string;
  required?: string[];
  additionalProperties?: boolean | SchemaNode;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateAgainstSchema(
  value: unknown, schema: SchemaNode, pathPrefix = '$',
): ValidationResult {
  const errors: string[] = [];
  _walk(value, schema, pathPrefix, errors);
  return { valid: errors.length === 0, errors };
}

function _walk(value: unknown, schema: SchemaNode, p: string, errors: string[]): void {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => _typeMatch(value, t))) {
      errors.push(`${p}: expected type ${types.join(' | ')}, got ${_typeOf(value)}`);
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value as never)) {
    errors.push(`${p}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.pattern !== undefined && typeof value === 'string') {
    if (!new RegExp(schema.pattern).test(value)) {
      errors.push(`${p}: string "${value}" does not match pattern /${schema.pattern}/`);
    }
  }
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) {
    errors.push(`${p}: string shorter than minLength ${schema.minLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${p}: number ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${p}: number ${value} > maximum ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push(`${p}: number ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      _walk(value[i], schema.items, `${p}[${i}]`, errors);
    }
  }
  if (_typeMatch(value, 'object') && value !== null) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (schema.required) {
      for (const req of schema.required) {
        if (!(req in obj)) errors.push(`${p}: missing required property "${req}"`);
      }
    }
    if (schema.properties) {
      for (const k of keys) {
        const subSchema = schema.properties[k];
        if (subSchema) _walk(obj[k], subSchema, `${p}.${k}`, errors);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const k of keys) {
        if (!allowed.has(k)) errors.push(`${p}: additional property "${k}" not permitted`);
      }
    }
  }
}

function _typeMatch(value: unknown, t: string): boolean {
  switch (t) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number';
    case 'string': return typeof value === 'string';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    default: return false;
  }
}

function _typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
