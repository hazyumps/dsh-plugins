/**
 * Usage — the Host half.
 *
 * Answers one question for the browser half: what have these providers cost,
 * and what is left. The balance comes from the provider over the same API key
 * the model route uses; the tokens come from the Harness's own session logs.
 * Nothing here trusts the client — the whole report is built Host-side and
 * validated on the way out by `lib/typert.host.js`.
 *
 * @module dsh-plugin-usage
 */

import os from 'node:os';
import path from 'node:path';

import { DEFAULT_ORIGIN, readBalance } from './lib/balance.js';
import { createScanCache, dayFormatter, dayKey, scanSessions } from './lib/scan.js';
import { describeProviders } from './lib/registry.js';
import { buildReport } from './lib/report.js';

/** Cordis service key, Remote namespace, and plugin name. */
export const name = 'usage';

/**
 * Host services this plugin needs. Deliberately empty: the credentials service
 * is read lazily through `ctx.get`, so a profile without one still gets token
 * spend and falls back to the launch environment for the key.
 */
export const inject = [];

/**
 * Settings, read from the launch environment.
 *
 * There is no schemastery `Config` export on purpose. A plugin installed into a
 * profile by path resolves no bare dependencies — `@deepseek-ai/schemastery` is
 * not on its resolution path, and importing it fails the entry at load with
 * "failed to import". Environment variables are the dependency-free equivalent,
 * and the defaults below are what the panel uses out of the box.
 */
const SETTINGS_DEFAULTS = Object.freeze({
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  origin: DEFAULT_ORIGIN,
  timeZone: '',
  historyDays: 30,
  refreshSeconds: 60,
});

/**
 * Read one setting from the launch environment.
 * @param key - Environment variable name.
 * @param fallback - Value when unset or empty.
 * @returns The value or the fallback.
 */
function env(key, fallback) {
  const value = process.env[key];
  if (value === undefined || value === null || value === '') return fallback;
  return value;
}

/**
 * Read a positive number from the launch environment.
 * @param key - Environment variable name.
 * @param fallback - Value when unset or unusable.
 * @returns A finite positive number.
 */
function envNumber(key, fallback) {
  const value = Number(env(key, fallback));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The harness home, as the Host reports it.
 * @returns The absolute path of the harness home directory.
 */
export function harnessHome() {
  const configured = process.env['DSH_HOME'];
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : path.join(os.homedir(), '.dsh');
}

/**
 * A credentials reader that falls back to the launch environment.
 *
 * The provider plugin does the same: a key exported in the launching shell is a
 * credential even when no store is mounted.
 * @param ctx - The plugin Context.
 * @returns An object with `resolve(ref)`.
 */
function credentialReader(ctx) {
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
  if (credentials !== undefined && credentials !== null) return credentials;
  return {
    resolve: async (ref) => {
      const value = process.env[ref];
      return typeof value === 'string' && value.length > 0
        ? { value, source: 'environment' }
        : undefined;
    },
  };
}

/**
 * Mount the service.
 * @param ctx - The plugin Context.
 */
export function apply(ctx) {
  const logger = ctx.logger;
  const cache = createScanCache();
  let balance = null;
  let balanceAt = 0;

  /** Current settings, read at the moment of use. */
  const settings = () => ({
    apiKeyEnv: env('DSH_USAGE_API_KEY_ENV', SETTINGS_DEFAULTS.apiKeyEnv),
    origin: env('DSH_USAGE_ORIGIN', SETTINGS_DEFAULTS.origin),
    sessionsRoot: env('DSH_USAGE_SESSIONS_ROOT', path.join(harnessHome(), 'sessions')),
    timeZone: env('DSH_USAGE_TIMEZONE', SETTINGS_DEFAULTS.timeZone),
    historyDays: envNumber('DSH_USAGE_HISTORY_DAYS', SETTINGS_DEFAULTS.historyDays),
    refreshSeconds: envNumber('DSH_USAGE_REFRESH_SECONDS', SETTINGS_DEFAULTS.refreshSeconds),
  });

  const service = {
    /**
     * Build the report.
     * @param request - `{ days?, refresh? }`.
     * @returns The summary payload.
     */
    async summary(request = {}) {
      const current = settings();
      const now = Date.now();

      const stale = balance === null || (now - balanceAt) > current.refreshSeconds * 1000;
      if (request.refresh === true || stale) {
        balance = await readBalance({
          credentialRef: current.apiKeyEnv,
          credentials: credentialReader(ctx),
          origin: current.origin,
          now,
        });
        balanceAt = now;
      }

      const scan = scanSessions({
        root: current.sessionsRoot,
        timeZone: current.timeZone,
        cache,
        now,
      });

      const configured = new Set(balance.status === 'not-configured' ? [] : [current.apiKeyEnv]);
      const providers = describeProviders({ configured, balance });

      const report = buildReport({
        scan,
        balance,
        providers,
        credentialRef: current.apiKeyEnv,
        today: dayKey(now, dayFormatter(current.timeZone)),
        days: request.days ?? current.historyDays,
        now,
      });
      logger?.debug?.(
        `usage: ${report.byModel.length} model(s), `
        + `${report.scan.files} log(s) in ${report.scan.ms} ms `
        + `(${report.scan.cached} cached), balance ${balance.status}`,
      );
      return report;
    },
  };

  // The exact visible protocol binding; strict reflection is contributed
  // separately by ./typert, with no decorator or source discovery.
  service.typertRemote = Object.freeze({ service, serviceKey: name, namespace: name });
  ctx.provide(name, service);
}
