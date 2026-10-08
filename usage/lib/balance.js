/**
 * Provider balance over an API key.
 *
 * DeepSeek exposes the wallet behind the same key the model route uses:
 * `GET /user/balance` with `Authorization: Bearer <key>` answers the topped-up
 * and granted balances per currency. No account sign-in, no browser session.
 *
 * @module dsh-plugin-usage/balance
 */

/** The official origin, and the path the balance lives at. */
export const DEFAULT_ORIGIN = 'https://api.deepseek.com';
export const BALANCE_PATH = '/user/balance';

/**
 * Normalize one wallet row.
 * @param wallet - A `balance_infos` entry, as the API sends it.
 * @returns The typed wallet, or null when the row is unusable.
 */
export function normalizeWallet(wallet) {
  if (wallet === null || typeof wallet !== 'object') return null;
  const currency = typeof wallet.currency === 'string' ? wallet.currency : '';
  if (currency.length === 0) return null;
  return {
    currency,
    total: stringOr(wallet.total_balance),
    granted: stringOr(wallet.granted_balance),
    toppedUp: stringOr(wallet.topped_up_balance),
  };
}

/**
 * Coerce a possibly-absent numeric string.
 * @param value - Raw field.
 * @returns The string, or `'0'`.
 */
function stringOr(value) {
  return typeof value === 'string' && value.length > 0 ? value : '0';
}

/**
 * Normalize a whole balance response.
 * @param payload - Parsed JSON body.
 * @returns `{ available, wallets }`.
 */
export function normalizeBalance(payload) {
  const wallets = Array.isArray(payload?.balance_infos)
    ? payload.balance_infos.map(normalizeWallet).filter((wallet) => wallet !== null)
    : [];
  return { available: payload?.is_available !== false, wallets };
}

/**
 * Read the provider balance.
 *
 * Every expected failure is a status, never a throw: a missing key, an HTTP
 * error, and a timeout all render as `unavailable` in the panel, because a
 * balance the plugin cannot read is not a reason for the page to break.
 * @param options - Read options.
 * @param options.credentialRef - Credential name to resolve, e.g. `DEEPSEEK_API_KEY`.
 * @param options.credentials - The Host credentials service.
 * @param options.origin - API origin.
 * @param options.fetchImpl - Fetch implementation, injectable for tests.
 * @param options.timeoutMs - Request timeout.
 * @param options.now - Epoch milliseconds, injectable for tests.
 * @returns The balance status object.
 */
export async function readBalance(options) {
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const now = options.now ?? Date.now();
  const ref = options.credentialRef;

  let resolved;
  try {
    resolved = await options.credentials?.resolve(ref);
  } catch (error) {
    return failure('unavailable', origin, now, `could not read ${ref}: ${String(error?.message ?? error)}`);
  }
  const key = resolved?.value;
  if (typeof key !== 'string' || key.length === 0) {
    return failure('not-configured', origin, now, `no API key stored for ${ref}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}${BALANCE_PATH}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return failure('unavailable', origin, now, `${origin}${BALANCE_PATH} answered HTTP ${response.status}`);
    }
    const payload = await response.json();
    const { available, wallets } = normalizeBalance(payload);
    return {
      status: 'ready',
      source: `${origin}${BALANCE_PATH}`,
      checkedAt: now,
      message: available ? null : 'The provider reports this key has no available balance.',
      available,
      wallets,
    };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return failure(
      'unavailable',
      origin,
      now,
      timedOut ? `no answer within ${timeoutMs} ms` : String(error?.message ?? error),
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build an unready balance object.
 * @param status - `unavailable` or `not-configured`.
 * @param origin - API origin.
 * @param now - Epoch milliseconds.
 * @param message - Human-readable reason.
 * @returns The balance object.
 */
function failure(status, origin, now, message) {
  return {
    status,
    source: `${origin}${BALANCE_PATH}`,
    checkedAt: now,
    message,
    available: false,
    wallets: [],
  };
}
