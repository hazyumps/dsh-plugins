/**
 * The provider registry.
 *
 * One row per provider this Harness routes to, describing how its money is
 * known: an API-key wallet, a local model that costs nothing, or a provider
 * that is not wired up yet. New providers are added here and, when they need
 * live numbers, given a reader module.
 *
 * @module dsh-plugin-usage/registry
 */

/**
 * @typedef {object} Provider
 * @property {string} id - The `provider` field DSH records in session logs.
 * @property {string} label - Display name.
 * @property {'api-key'|'local'|'unknown'} kind - How spend is incurred.
 * @property {string|null} credentialRef - Credential that pays for it.
 * @property {string|null} origin - API origin carrying the balance.
 * @property {string} note - One line shown in the panel.
 */

/** Every provider the plugin knows about. */
export const PROVIDERS = Object.freeze([
  {
    id: 'deepseek-official',
    label: 'DeepSeek',
    kind: 'api-key',
    credentialRef: 'DEEPSEEK_API_KEY',
    origin: 'https://api.deepseek.com',
    note: 'Official API, billed against the key balance.',
  },
  {
    id: 'gaia-local',
    label: 'Local (Spark / Ember)',
    kind: 'local',
    credentialRef: null,
    origin: null,
    note: 'House LiteLLM gateway; no per-token charge.',
  },
]);

/**
 * One provider row by id.
 * @param id - Provider id from a session log.
 * @returns The provider, or a synthesized unknown-provider row.
 */
export function provider(id) {
  const known = PROVIDERS.find((entry) => entry.id === id);
  if (known !== undefined) return known;
  return {
    id,
    label: id,
    kind: 'unknown',
    credentialRef: null,
    origin: null,
    note: 'Not described by the usage plugin; spend is uncounted.',
  };
}

/**
 * Display label for a provider/model pair.
 * @param providerId - Provider id.
 * @param model - Model id.
 * @returns A short label.
 */
export function modelLabel(providerId, model) {
  const entry = provider(providerId);
  return entry.kind === 'local' ? `${model} (local)` : model;
}

/**
 * Provider rows with the state each one is in for this Host.
 * @param options - Status inputs.
 * @param options.configured - Credential refs that resolve to a value.
 * @param options.balance - The balance object that was read, if any.
 * @returns Provider rows for the panel.
 */
export function describeProviders(options) {
  const configured = options.configured ?? new Set();
  const balance = options.balance;
  return PROVIDERS.map((entry) => {
    let status = 'ready';
    if (entry.kind === 'local') status = 'free';
    else if (entry.credentialRef === null) status = 'unknown';
    else if (!configured.has(entry.credentialRef)) status = 'no-key';
    else if (balance !== undefined && balance.status !== 'ready') status = 'unreadable';
    return {
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      status,
      note: entry.note,
    };
  });
}
