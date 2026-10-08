/**
 * Wire shapes for the `mcp` namespace.
 *
 * The gateway validates every strict codec with `codec.create().parse(value)`
 * (`dsh-api-gateway`: `decode()`), so each type here is an object with a
 * `parse` method. It is hand-rolled rather than zod on purpose: a plugin
 * installed into a profile by path resolves **no** bare dependencies — zod is
 * not installed for the linked package and the Harness's own
 * `@deepseek-ai/*` packages are not on the plugin's resolution path. A plugin
 * that imports either fails to activate with "failed to import".
 *
 * Objects are validated strictly: an unknown key is an error, not something to
 * strip, so the server list and this contract cannot drift apart silently.
 * That is also the guarantee that keeps a credential out of the browser: the
 * row shape has no field a header or env value could be carried in.
 *
 * @module dsh-plugin-mcp/schema
 */

/**
 * @typedef {object} Spec
 * @property {string} type - `object`, `array`, `string`, `number`, `boolean`, `enum`, `nullable`.
 * @property {boolean} [optional] - Absent is allowed.
 * @property {Record<string, Spec>} [fields] - For `object`.
 * @property {Spec} [item] - For `array`.
 * @property {Spec} [inner] - For `nullable`.
 * @property {string[]} [values] - For `enum`.
 * @property {boolean} [integer] - For `number`.
 * @property {number} [min] - For `number`.
 * @property {number} [max] - For `number`.
 */

/** Spec constructors, kept terse so a shape reads like its own declaration. */
const S = {
  string: () => ({ type: 'string' }),
  number: (options = {}) => ({ type: 'number', ...options }),
  boolean: () => ({ type: 'boolean' }),
  enum: (values) => ({ type: 'enum', values }),
  array: (item) => ({ type: 'array', item }),
  object: (fields) => ({ type: 'object', fields }),
  nullable: (inner) => ({ type: 'nullable', inner }),
  optional: (spec) => ({ ...spec, optional: true }),
};

/**
 * Validate one value against a spec.
 *
 * Returns the value itself for scalars and a rebuilt object for `object`
 * specs, so the caller can hand the result straight back to the wire.
 * @param spec - The spec.
 * @param value - Candidate value.
 * @param path - Dotted path, for the error message.
 * @returns The validated value.
 * @throws {TypeError} When the value does not match.
 */
function check(spec, value, path) {
  if (value === undefined) {
    if (spec.optional === true) return undefined;
    throw new TypeError(`${path} is required`);
  }

  switch (spec.type) {
    case 'nullable': {
      if (value === null) return null;
      return check(spec.inner, value, path);
    }
    case 'string': {
      if (typeof value !== 'string') throw new TypeError(`${path} must be a string, got ${typeof value}`);
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') throw new TypeError(`${path} must be a boolean, got ${typeof value}`);
      return value;
    }
    case 'enum': {
      if (!spec.values.includes(value)) {
        throw new TypeError(`${path} must be one of ${spec.values.join(', ')}, got ${JSON.stringify(value)}`);
      }
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${path} must be a finite number, got ${typeof value}`);
      }
      if (spec.integer === true && !Number.isInteger(value)) throw new TypeError(`${path} must be an integer`);
      if (spec.min !== undefined && value < spec.min) throw new TypeError(`${path} must be >= ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) throw new TypeError(`${path} must be <= ${spec.max}`);
      return value;
    }
    case 'array': {
      if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
      return value.map((item, index) => check(spec.item, item, `${path}[${index}]`));
    }
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${path} must be an object`);
      }
      const known = spec.fields;
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(known, key)) {
          throw new TypeError(`${path} has an unknown field ${JSON.stringify(key)} — the contract and the server list disagree`);
        }
      }
      const result = {};
      for (const [key, field] of Object.entries(known)) {
        const parsed = check(field, value[key], `${path}.${key}`);
        if (parsed !== undefined) result[key] = parsed;
      }
      return result;
    }
    default:
      throw new TypeError(`${path} has an unsupported spec type ${JSON.stringify(spec.type)}`);
  }
}

/**
 * Wrap a spec as the schema object a codec's `create()` must return.
 * @param spec - The spec.
 * @returns `{ parse(value) }`.
 */
function schema(spec) {
  return {
    parse(value) {
      return check(spec, value, 'value');
    },
  };
}

/** One MCP server, as the browser half is allowed to see it. */
const serverSpec = S.object({
  id: S.string(),
  serverName: S.string(),
  moduleName: S.string(),
  enabled: S.boolean(),
  phase: S.enum(['idle', 'pending', 'loading', 'active', 'failed', 'unloading']),
  transport: S.enum(['http', 'stdio', 'other']),
  target: S.string(),
  authenticated: S.boolean(),
  timeoutMs: S.nullable(S.number({ integer: true, min: 1 })),
  toolPrefix: S.string(),
  toolCount: S.nullable(S.number({ integer: true, min: 0 })),
});

/** Totals across every row, so the page can summarize without re-counting. */
const totalsSpec = S.object({
  servers: S.number({ integer: true, min: 0 }),
  enabled: S.number({ integer: true, min: 0 }),
  active: S.number({ integer: true, min: 0 }),
  failed: S.number({ integer: true, min: 0 }),
  tools: S.nullable(S.number({ integer: true, min: 0 })),
});

/** What the panel asks for. No fields today; a strict empty object. */
export const listRequest = schema(S.object({}));

/** The whole server list. */
export const listResult = schema(S.object({
  generatedAt: S.number({ integer: true, min: 0 }),
  servers: S.array(serverSpec),
  totals: totalsSpec,
}));

/** The row schema on its own, for tests that exercise one server at a time. */
export const serverRow = schema(serverSpec);

/** The totals schema on its own. */
export const totalsRow = schema(totalsSpec);

/** Short type symbol -> schema, for the Typert codecs. */
export const SCHEMAS = {
  ListRequest: listRequest,
  ListResult: listResult,
};

/** Exported for tests that want to exercise the validator directly. */
export { schema, S as specs };
