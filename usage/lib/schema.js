/**
 * Wire shapes for the `usage` namespace.
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
 * strip, so the report and this contract cannot drift apart silently.
 *
 * @module dsh-plugin-usage/schema
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
          throw new TypeError(`${path} has an unknown field ${JSON.stringify(key)} — the contract and the report disagree`);
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

/** One token counter, totals plus the peak slice. */
const tokens = S.object({
  input: S.number(),
  cacheRead: S.number(),
  cacheWrite: S.number(),
  output: S.number(),
  steps: S.number(),
  peakInput: S.number(),
  peakCacheRead: S.number(),
  peakCacheWrite: S.number(),
  peakOutput: S.number(),
  peakSteps: S.number(),
});

/** One wallet row from the provider. */
const wallet = S.object({
  currency: S.string(),
  total: S.string(),
  granted: S.string(),
  toppedUp: S.string(),
});

/** The balance read. */
const balance = S.object({
  status: S.enum(['ready', 'unavailable', 'not-configured']),
  source: S.string(),
  checkedAt: S.number(),
  message: S.nullable(S.string()),
  available: S.boolean(),
  wallets: S.array(wallet),
});

/** Spend over one window. */
const spend = S.object({
  cost: S.number(),
  currency: S.string(),
  tokens,
  days: S.nullable(S.number()),
});

/** What the panel asks for. */
export const summaryRequest = schema(S.object({
  days: S.optional(S.number({ integer: true, min: 1, max: 365 })),
  refresh: S.optional(S.boolean()),
}));

/** The whole report. */
export const summaryResult = schema(S.object({
  generatedAt: S.number(),
  credentialRef: S.nullable(S.string()),
  balance: S.nullable(balance),
  spend: S.object({ today: spend, last7: spend, last30: spend, all: spend }),
  tokens,
  byModel: S.array(S.object({
    provider: S.string(),
    model: S.string(),
    label: S.string(),
    kind: S.string(),
    input: S.number(),
    cacheRead: S.number(),
    cacheWrite: S.number(),
    output: S.number(),
    steps: S.number(),
    cost: S.number(),
    priced: S.boolean(),
  })),
  byDay: S.array(S.object({
    day: S.string(),
    cost: S.number(),
    input: S.number(),
    cacheRead: S.number(),
    cacheWrite: S.number(),
    output: S.number(),
    steps: S.number(),
  })),
  providers: S.array(S.object({
    id: S.string(),
    label: S.string(),
    kind: S.string(),
    status: S.string(),
    note: S.string(),
  })),
  price: S.object({
    verified: S.string(),
    source: S.string(),
    unit: S.string(),
    peakHours: S.string(),
  }),
  scan: S.object({
    root: S.string(),
    files: S.number(),
    sessions: S.number(),
    bytes: S.number(),
    records: S.number(),
    usageRecords: S.number(),
    ms: S.number(),
    cached: S.number(),
  }),
}));

/** Short type symbol -> schema, for the Typert codecs. */
export const SCHEMAS = {
  SummaryRequest: summaryRequest,
  SummaryResult: summaryResult,
};

/** Exported for tests that want to exercise the validator directly. */
export { schema, S as specs };
