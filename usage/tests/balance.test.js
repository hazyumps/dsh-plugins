import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeBalance, normalizeWallet, readBalance } from '../lib/balance.js';

/** A credentials stub that resolves one key. */
function store(value = 'sk-test') {
  return { resolve: async () => (value === null ? undefined : { value, source: 'test' }) };
}

/** A fetch stub answering one body. */
function fetchJson(body, status = 200) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { impl, calls };
}

const PAYLOAD = {
  is_available: true,
  balance_infos: [{ currency: 'USD', total_balance: '62.89', granted_balance: '0.00', topped_up_balance: '62.89' }],
};

test('normalizes the provider payload', () => {
  assert.deepEqual(normalizeBalance(PAYLOAD), {
    available: true,
    wallets: [{ currency: 'USD', total: '62.89', granted: '0.00', toppedUp: '62.89' }],
  });
});

test('treats is_available false as a successful read with no balance', () => {
  const normal = normalizeBalance({ is_available: false, balance_infos: [] });
  assert.equal(normal.available, false);
  assert.deepEqual(normal.wallets, []);
});

test('drops wallet rows without a currency', () => {
  assert.equal(normalizeWallet({ total_balance: '1' }), null);
  assert.equal(normalizeWallet(null), null);
  assert.deepEqual(normalizeWallet({ currency: 'CNY' }), { currency: 'CNY', total: '0', granted: '0', toppedUp: '0' });
});

test('reads the balance over the API key', async () => {
  const { impl, calls } = fetchJson(PAYLOAD);
  const result = await readBalance({
    credentialRef: 'DEEPSEEK_API_KEY',
    credentials: store(),
    fetchImpl: impl,
    now: 1_700_000_000_000,
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.wallets[0].total, '62.89');
  assert.equal(result.source, 'https://api.deepseek.com/user/balance');
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test');
});

test('reports a missing key as not-configured, not as an error', async () => {
  const result = await readBalance({ credentialRef: 'DEEPSEEK_API_KEY', credentials: store(null), fetchImpl: async () => {
    throw new Error('must not be called');
  } });
  assert.equal(result.status, 'not-configured');
  assert.match(result.message, /DEEPSEEK_API_KEY/);
});

test('reports an HTTP failure without throwing', async () => {
  const { impl } = fetchJson({}, 402);
  const result = await readBalance({ credentialRef: 'K', credentials: store(), fetchImpl: impl });
  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /HTTP 402/);
});

test('reports a network failure without throwing', async () => {
  const result = await readBalance({
    credentialRef: 'K',
    credentials: store(),
    fetchImpl: async () => { throw new Error('fetch failed'); },
  });
  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /fetch failed/);
});

test('reports a credentials-service failure as unavailable', async () => {
  const result = await readBalance({
    credentialRef: 'K',
    credentials: { resolve: async () => { throw new Error('store offline'); } },
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /store offline/);
});

test('aborts a slow request instead of hanging the panel', async () => {
  const result = await readBalance({
    credentialRef: 'K',
    credentials: store(),
    timeoutMs: 5,
    fetchImpl: (url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /no answer within 5 ms/);
});
