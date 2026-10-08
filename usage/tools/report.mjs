/**
 * Print the usage report the panel renders, without the panel.
 *
 * Development and debugging aid: it runs exactly the modules `index.js` wires
 * together — scan, balance read, pricing, report — so "the panel shows nothing"
 * can be separated from "the numbers are wrong". It reads the credential from
 * the launch environment first, then from the harness's own credential store.
 *
 * Usage:
 *   node tools/report.mjs [--days 30] [--sessions PATH] [--no-balance] [--json]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readBalance } from '../lib/balance.js';
import { buildReport } from '../lib/report.js';
import { createScanCache, dayFormatter, dayKey, scanSessions } from '../lib/scan.js';
import { describeProviders } from '../lib/registry.js';

const argv = process.argv.slice(2);
/** The value after a flag, or the fallback. */
function flag(name, fallback) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
}

const days = Number(flag('days', 30));
const json = argv.includes('--json');
const withBalance = !argv.includes('--no-balance');
const home = process.env['DSH_HOME'] ?? path.join(os.homedir(), '.dsh');
const sessionsRoot = flag('sessions', path.join(home, 'sessions'));
const apiKeyEnv = flag('key-env', 'DEEPSEEK_API_KEY');

/**
 * The credential, from the environment or the harness store.
 *
 * The store parse is a deliberate substring match rather than a YAML parse: it
 * is one flat `refs:` map in a file this tool only ever reads.
 * @param ref - Credential name.
 * @returns The value, or undefined.
 */
function credential(ref) {
  const ambient = process.env[ref];
  if (typeof ambient === 'string' && ambient.length > 0) return ambient;
  try {
    const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
    const match = text.match(new RegExp(`^\\s*${ref}:\\s*(.+)$`, 'm'));
    if (match === null) return undefined;
    return match[1].trim().replace(/^["']|["']$/g, '');
  } catch {
    return undefined;
  }
}

const cache = createScanCache();
const scan = scanSessions({ root: sessionsRoot, timeZone: '', cache });

let balance = null;
const configured = new Set();
if (withBalance) {
  balance = await readBalance({
    credentialRef: 'DEEPSEEK_API_KEY',
    credentials: { resolve: async (ref) => {
      const value = credential(ref);
      return value === undefined ? undefined : { value, source: 'store' };
    } },
  });
  if (balance.status !== 'not-configured') configured.add('DEEPSEEK_API_KEY');
}

const now = Date.now();
const report = buildReport({
  scan,
  balance,
  providers: describeProviders({ configured, balance }),
  today: dayKey(now, dayFormatter('')),
  days,
  now,
});

if (json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

/** Compact token count. */
function tokens(value) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(value ?? 0);
}

/** USD. */
function usd(value) {
  const number = Number(value) || 0;
  if (number === 0) return '$0.00';
  return number < 0.01 ? '<$0.01' : `$${number.toFixed(2)}`;
}

console.log(`sessions   ${report.scan.root}`);
console.log(`scan       ${report.scan.files} log(s), ${report.scan.records} rows, ${report.scan.usageRecords} with usage, ${report.scan.ms} ms`);
if (report.balance !== null) {
  const wallet = report.balance.wallets[0];
  console.log(`balance    ${report.balance.status}${wallet === undefined ? '' : ` ${wallet.currency} ${wallet.total} (topped up ${wallet.toppedUp}, granted ${wallet.granted})`}${report.balance.message === null ? '' : ` — ${report.balance.message}`}`);
}
console.log(`spend      today ${usd(report.spend.today.cost)} · 7d ${usd(report.spend.last7.cost)} · 30d ${usd(report.spend.last30.cost)} · all ${usd(report.spend.all.cost)}`);
console.log(`tokens     in ${tokens(report.tokens.input)} uncached, ${tokens(report.tokens.cacheRead)} cached, out ${tokens(report.tokens.output)} over ${report.tokens.steps} step(s)`);
console.log('');
console.log('model'.padEnd(34), 'cost'.padStart(10), 'in'.padStart(8), 'cached'.padStart(9), 'out'.padStart(8), 'steps'.padStart(6));
for (const row of report.byModel) {
  console.log(
    row.label.padEnd(34),
    (row.priced ? usd(row.cost) : '—').padStart(10),
    tokens(row.input).padStart(8),
    tokens(row.cacheRead).padStart(9),
    tokens(row.output).padStart(8),
    String(row.steps).padStart(6),
  );
}
console.log('');
console.log('day'.padEnd(14), 'cost'.padStart(10), 'in'.padStart(8), 'cached'.padStart(9), 'out'.padStart(8));
for (const row of report.byDay) {
  console.log(
    row.day.padEnd(14),
    usd(row.cost).padStart(10),
    tokens(row.input).padStart(8),
    tokens(row.cacheRead).padStart(9),
    tokens(row.output).padStart(8),
  );
}
console.log('');
for (const row of report.providers) console.log(`provider   ${row.label} [${row.status}] ${row.note}`);
console.log(`rates      verified ${report.price.verified} — ${report.price.source}`);
