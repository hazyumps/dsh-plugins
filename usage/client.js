/**
 * Usage — the browser half.
 *
 * A classic-script DSH client plugin: it mounts the `usage` Remote namespace
 * (the same descriptor ids the Host registers through `./typert`), adds a
 * sidebar entry, and renders the balance / spend / token report.
 *
 * Ground rules this file follows (recon-client.md §2, §4, §5, §9):
 *   - `id` MUST equal the package name or the loader row never resolves.
 *   - No `import`, no bundler, and never `require` an `@deepseek-ai/dsh-client-*`
 *     package: a throw there blanks the slot entry silently.
 *   - `main` takes `key`; `sidebar.panellist` takes `id`. Swapping them throws.
 *   - Everything visible goes through `ctx.locale` and theme tokens.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-usage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PACKAGE = 'dsh-plugin-usage';
    const NAMESPACE = 'usage';
    const NS = 'usage';
    const PANEL_ID = 'usage';
    const NAMESPACE_TIMEOUT_MS = 10_000;
    const REFRESH_MS = 60_000;

    // ---------------------------------------------------------------------
    // Locale
    // ---------------------------------------------------------------------

    const en = {
      'panel': 'Usage',
      'page.title': 'Usage',
      'page.subtitle': 'Balance and token spend for the providers this Harness routes to.',
      'page.refresh': 'Refresh',
      'page.loading': 'Reading…',
      'page.asOf': 'as of {time}',
      'page.error': 'Could not read usage: {message}',
      'balance.title': 'Balance',
      'balance.unavailable': 'Unavailable',
      'balance.missing': 'No API key stored for {ref}. Add one on the Models page, then refresh.',
      'balance.error': 'The provider did not answer. The last known balance is shown when there is one.',
      'balance.toppedUp': 'topped up',
      'balance.granted': 'granted',
      'balance.checked': 'checked {time}',
      'spend.today': 'Today',
      'spend.last7': 'Last 7 days',
      'spend.last30': 'Last 30 days',
      'spend.all': 'All time',
      'spend.estimated': 'estimated',
      'tokens.title': 'Tokens',
      'tokens.input': 'Input (uncached)',
      'tokens.cacheRead': 'Input (cached)',
      'tokens.cacheWrite': 'Cache write',
      'tokens.output': 'Output',
      'tokens.steps': 'Model steps',
      'models.title': 'By model',
      'models.empty': 'No session usage found yet. Run a turn and refresh.',
      'models.model': 'Model',
      'models.cost': 'Cost',
      'models.input': 'In',
      'models.cacheRead': 'Cached',
      'models.output': 'Out',
      'models.steps': 'Steps',
      'models.unpriced': 'no rate',
      'models.free': 'free',
      'days.title': 'By day',
      'days.day': 'Day',
      'providers.title': 'Providers',
      'providers.ready': 'ready',
      'providers.free': 'no charge',
      'providers.no-key': 'no key',
      'providers.unreadable': 'unreadable',
      'providers.unknown': 'unknown',
      'providers.not-described': 'not described',
      'scan.summary': 'Read {files} session log(s) in {ms} ms ({cached} cached).',
      'scan.none': 'No session logs found under {root}.',
      'price.note': 'Rates verified {verified} ({unit}). {peakHours}',
      'price.source': 'Price list',
    };

    // ---------------------------------------------------------------------
    // Formatting
    // ---------------------------------------------------------------------

    const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
    const plain = new Intl.NumberFormat('en-US');

    /** Compact token count: 126.6M, 1.02M, 627.4K. */
    function tokens(value) {
      const number = Number(value) || 0;
      if (number === 0) return '0';
      if (number < 1000) return plain.format(number);
      return compact.format(number);
    }

    /** USD, always two decimals unless it rounds to zero. */
    function usd(value) {
      const number = Number(value) || 0;
      if (number === 0) return '$0.00';
      if (number < 0.01) return '<$0.01';
      return `$${number.toFixed(2)}`;
    }

    /** Clock time from epoch milliseconds. */
    function clock(value) {
      if (typeof value !== 'number' || value <= 0) return '—';
      return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    /** Fill `{name}` placeholders. */
    function fill(text, values) {
      return String(text).replace(/\{(\w+)\}/g, (_match, key) => (
        values[key] === undefined ? '' : String(values[key])
      ));
    }

    /**
     * A provider status word, translated when the dictionary has it.
     * `ctx.locale.bind` answers with the key itself for a missing entry, so
     * an unmapped status still renders as a readable word.
     */
    function statusLabel(t, status) {
      const key = `providers.${status}`;
      const label = t(key);
      return label === key ? status : label;
    }

    // ---------------------------------------------------------------------
    // Remote contribution
    // ---------------------------------------------------------------------

    /**
     * One strict codec. The gateway only checks `mode === 'strict'` on the
     * client side and never executes the schema, so `create` is a stub — the
     * Host owns the real validation through `lib/typert.host.js`.
     */
    function strictCodec(typeSymbol) {
      return { mode: 'strict', typeSymbol: `${PACKAGE}#${typeSymbol}`, create: () => undefined };
    }

    /** The one invocation, matching `lib/contract.js` exactly. */
    const CONTRIBUTION = Object.freeze({
      package: PACKAGE,
      descriptors: [{
        id: `${PACKAGE}#${NAMESPACE}/summary`,
        service: NAMESPACE,
        namespace: NAMESPACE,
        method: 'summary',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: strictCodec('SummaryRequest'),
        }],
        result: strictCodec('SummaryResult'),
      }],
    });

    /** A normalized Remote failure, shaped like the real `{ok:false,error}`. */
    function failure(code, message) {
      return { ok: false, error: { code, message } };
    }

    /** Call one method on a resolved namespace service. */
    async function invoke(service, method, request) {
      try {
        const fn = service[method];
        if (typeof fn !== 'function') {
          return failure('gateway/invocation-unavailable', `the ${NAMESPACE} namespace has no "${method}" method`);
        }
        return await (request === undefined ? fn.call(service) : fn.call(service, request));
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : `${PACKAGE}/failed`;
        return failure(code, String(error?.message ?? error));
      }
    }

    /** One `$mount` per root Context. */
    const MOUNTS = new WeakMap();

    /** Wait for the mounted namespace to appear as its own Cordis service. */
    function openNamespace(ctx, timeoutMs) {
      return new Promise((resolve, reject) => {
        let fiber = null;
        let settled = false;
        let abandoned = false;

        const drop = () => {
          abandoned = true;
          Promise.resolve(fiber !== null && typeof fiber.dispose === 'function' ? fiber.dispose() : null)
            .catch(() => {});
        };

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          drop();
          reject(new Error(`the ${NAMESPACE} Remote namespace did not become available`));
        }, timeoutMs);

        const settle = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback(value);
        };

        try {
          fiber = ctx.inject([`remote.${NAMESPACE}`], (scope) => {
            if (abandoned) return;
            settle(resolve, { service: scope.remote[NAMESPACE], dispose: drop });
          });
        } catch (error) {
          settle(reject, error);
          return;
        }
        if (abandoned) drop();
      });
    }

    /** Acquire (or share) the namespace mount for this root. */
    function acquireMount(ctx) {
      const owner = ctx.root || ctx.remote;
      let entry = MOUNTS.get(owner);

      if (entry === undefined || entry.failed || entry.closed) {
        const previous = entry === undefined ? null : entry.closing;
        entry = { refs: 0, closed: false, failed: false, scope: null, unmount: null, closing: undefined };
        // `$mount` installs LOCAL descriptors only; serialize behind any
        // pending unmount of a dead entry.
        entry.ready = Promise.resolve(previous)
          .catch(() => {})
          .then(() => ctx.remote.$mount(CONTRIBUTION))
          .then(async (unmount) => {
            entry.unmount = unmount;
            entry.scope = await openNamespace(ctx, NAMESPACE_TIMEOUT_MS);
            return entry.scope.service;
          })
          .catch((error) => {
            entry.failed = true;
            throw error;
          });
        entry.ready.catch(() => {});
        MOUNTS.set(owner, entry);
      }

      entry.refs += 1;
      let released = false;
      return {
        ready: entry.ready,
        get failed() {
          return entry.failed;
        },
        release() {
          if (released) return;
          released = true;
          entry.refs -= 1;
          if (entry.refs !== 0) return;
          entry.closing = Promise.resolve(entry.closing)
            .then(() => entry.ready.catch(() => {}))
            .then(async () => {
              if (entry.refs !== 0 || entry.closed) return;
              entry.closed = true;
              if (entry.scope !== null) entry.scope.dispose();
              if (typeof entry.unmount === 'function') await entry.unmount();
            })
            .catch(() => {})
            .finally(() => {
              if ((entry.closed || entry.failed) && MOUNTS.get(owner) === entry) MOUNTS.delete(owner);
            });
        },
      };
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    const PAGE_CSS = `
      .dsu-page {
        height: 100%; min-height: 0; overflow: auto;
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
        font-size: 14px; line-height: 1.6;
        padding: 28px clamp(20px, 4vw, 48px) 48px;
      }
      .dsu-head {
        display: flex; align-items: flex-start; justify-content: space-between;
        gap: 16px; margin-bottom: 20px;
      }
      .dsu-head h1 { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; }
      .dsu-sub { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; }
      .dsu-btn {
        height: 32px; padding: 0 14px; border: none; cursor: pointer;
        border-radius: var(--dsw-radius-md);
        font-size: 13px; line-height: 20px;
        color: var(--dsw-alias-label-primary-foreground);
        background: var(--dsw-alias-button-primary-fill);
        white-space: nowrap;
      }
      .dsu-btn:hover { background: var(--dsw-alias-button-primary-hover); }
      .dsu-btn[disabled] { opacity: 0.6; cursor: default; }
      .dsu-btn:focus-visible {
        outline: var(--dsw-focus-ring-width) solid
          var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 2px;
      }
      .dsu-cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
      .dsu-card {
        border: 0.5px solid var(--dsw-alias-border-l3);
        border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-bg-layer-1);
        padding: 14px 16px;
        min-width: 0;
      }
      .dsu-card-title { font-size: 12px; letter-spacing: 0.02em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
      .dsu-card-value { font-size: 24px; font-weight: 500; line-height: 32px; margin-top: 4px; }
      .dsu-card-note { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-top: 2px; }
      .dsu-card[data-tone="warn"] .dsu-card-value { color: var(--dsw-alias-state-warning-primary, inherit); }
      .dsu-section { margin-top: 28px; }
      .dsu-section h2 { font-size: 13px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.02em;
        color: var(--dsw-alias-label-tertiary); margin: 0 0 8px; }
      .dsu-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .dsu-table th {
        text-align: right; font-weight: 500; color: var(--dsw-alias-label-tertiary);
        padding: 6px 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l2); white-space: nowrap;
      }
      .dsu-table th:first-child, .dsu-table td:first-child { text-align: left; }
      .dsu-table td {
        text-align: right; padding: 6px 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l2);
        font-variant-numeric: tabular-nums;
      }
      .dsu-table tr:last-child td { border-bottom: none; }
      .dsu-model { display: flex; align-items: baseline; gap: 8px; }
      .dsu-muted { color: var(--dsw-alias-label-tertiary); }
      .dsu-tag {
        font-size: 11px; padding: 1px 6px; border-radius: 999px;
        border: 0.5px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary);
      }
      .dsu-list { margin: 0; padding: 0; list-style: none; }
      .dsu-list li { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; font-size: 13px; }
      .dsu-empty { color: var(--dsw-alias-label-tertiary); padding: 12px 0; }
      .dsu-error {
        border: 0.5px solid var(--dsw-alias-state-error-primary, var(--dsw-alias-border-l3));
        border-radius: var(--dsw-radius-md);
        padding: 10px 12px; margin-bottom: 16px; font-size: 13px;
      }
      .dsu-foot { margin-top: 28px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
      .dsu-foot a { color: inherit; }
      .dsu-grid { display: grid; gap: 4px 24px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
      .dsu-grid div { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
      .dsu-grid span:last-child { font-variant-numeric: tabular-nums; }
    `;

    // ---------------------------------------------------------------------
    // Stylesheet
    // ---------------------------------------------------------------------

    /**
     * Inject the panel stylesheet once, into `document.head`.
     *
     * Deliberately *not* a child of the component. A component-rendered
     * `<style>` dies with whatever subtree React tears down when the panel is
     * remounted — switching panels, or a slot re-registration — and the markup
     * then keeps working while rendering unstyled, which is exactly what was
     * observed. The shipped client plugins do the same thing: one tag per CSS
     * module, keyed on `data-plugin-css`, appended to the head
     * (`dsh-client-ui-schedule/lib/client.js`, every `.module.css` region).
     */
    const CSS_TAG_ID = `${PACKAGE}/panel.css`;

    /** Add the stylesheet if it is not already there. Idempotent. */
    function injectStyles() {
      if (typeof document === 'undefined' || document.head === null) return;
      const selector = `style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`;
      if (document.querySelector(selector) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = PACKAGE;
      tag.dataset.pluginCss = CSS_TAG_ID;
      tag.textContent = PAGE_CSS;
      document.head.appendChild(tag);
    }

    // ---------------------------------------------------------------------
    // Components
    // ---------------------------------------------------------------------

    /** One headline number. */
    function Card(props) {
      return h('div', { className: 'dsu-card', 'data-tone': props.tone },
        h('div', { className: 'dsu-card-title' }, props.title),
        h('div', { className: 'dsu-card-value' }, props.value),
        props.note === undefined ? null : h('div', { className: 'dsu-card-note' }, props.note),
      );
    }

    /** The balance card, which has its own empty and error states. */
    function BalanceCard(props) {
      const t = props.t;
      const balance = props.balance;

      if (balance === null || balance === undefined) {
        return h('div', { className: 'dsu-cards' },
          h(Card, { title: t('balance.title'), value: t('page.loading') }));
      }
      if (balance.status === 'not-configured') {
        return h('div', { className: 'dsu-cards' },
          h(Card, {
            title: t('balance.title'),
            value: t('balance.unavailable'),
            note: fill(t('balance.missing'), { ref: props.credentialRef }),
            tone: 'warn',
          }));
      }
      if (balance.status !== 'ready' || balance.wallets.length === 0) {
        return h('div', { className: 'dsu-cards' },
          h(Card, {
            title: t('balance.title'),
            value: t('balance.unavailable'),
            note: balance.message ?? t('balance.error'),
            tone: 'warn',
          }));
      }

      const wallet = balance.wallets[0];
      const symbol = wallet.currency === 'CNY' ? '¥' : '$';
      const amount = Number(wallet.total);
      const note = [
        `${symbol}${Number(wallet.toppedUp).toFixed(2)} ${t('balance.toppedUp')}`,
        Number(wallet.granted) > 0 ? `${symbol}${Number(wallet.granted).toFixed(2)} ${t('balance.granted')}` : null,
        fill(t('balance.checked'), { time: clock(balance.checkedAt) }),
      ].filter((part) => part !== null).join(' · ');

      return h('div', { className: 'dsu-cards' },
        h(Card, {
          title: `${t('balance.title')} · ${wallet.currency}`,
          value: `${symbol}${Number.isFinite(amount) ? amount.toFixed(2) : wallet.total}`,
          note,
          tone: Number.isFinite(amount) && amount <= 0 ? 'warn' : undefined,
        }));
    }

    /** Spend tiles for each window. */
    function SpendCards(props) {
      const t = props.t;
      const spend = props.spend;
      const windows = [
        ['spend.today', spend.today],
        ['spend.last7', spend.last7],
        ['spend.last30', spend.last30],
        ['spend.all', spend.all],
      ];
      return h('div', { className: 'dsu-cards' },
        windows.map(([key, window]) => h(Card, {
          key,
          title: t(key),
          value: usd(window.cost),
          note: `${tokens(window.tokens.output)} out · ${tokens(window.tokens.cacheRead + window.tokens.input)} in`,
        })),
      );
    }

    /** The token totals grid. */
    function TokenGrid(props) {
      const t = props.t;
      const tokensRow = props.tokens;
      const rows = [
        ['tokens.input', tokensRow.input],
        ['tokens.cacheRead', tokensRow.cacheRead],
        ['tokens.cacheWrite', tokensRow.cacheWrite],
        ['tokens.output', tokensRow.output],
        ['tokens.steps', plain.format(tokensRow.steps)],
      ];
      return h('div', { className: 'dsu-grid' },
        rows.map(([key, value]) => h('div', { key },
          h('span', { className: 'dsu-muted' }, t(key)),
          h('span', null, typeof value === 'number' ? tokens(value) : value),
        )),
      );
    }

    /** Per-model usage. */
    function ModelTable(props) {
      const t = props.t;
      if (props.rows.length === 0) return h('p', { className: 'dsu-empty' }, t('models.empty'));
      return h('table', { className: 'dsu-table' },
        h('thead', null, h('tr', null,
          h('th', null, t('models.model')),
          h('th', null, t('models.cost')),
          h('th', null, t('models.input')),
          h('th', null, t('models.cacheRead')),
          h('th', null, t('models.output')),
          h('th', null, t('models.steps')),
        )),
        h('tbody', null, props.rows.map((row) => h('tr', { key: `${row.provider}/${row.model}` },
          h('td', null,
            h('span', { className: 'dsu-model' },
              h('span', null, row.label),
              row.priced
                ? (row.kind === 'local' ? h('span', { className: 'dsu-tag' }, t('models.free')) : null)
                : h('span', { className: 'dsu-tag' }, t('models.unpriced')),
            ),
          ),
          h('td', null, row.priced ? usd(row.cost) : '—'),
          h('td', null, tokens(row.input)),
          h('td', null, tokens(row.cacheRead)),
          h('td', null, tokens(row.output)),
          h('td', null, plain.format(row.steps)),
        ))),
      );
    }

    /** Per-day usage, newest first. */
    function DayTable(props) {
      const t = props.t;
      if (props.rows.length === 0) return null;
      return h('table', { className: 'dsu-table' },
        h('thead', null, h('tr', null,
          h('th', null, t('days.day')),
          h('th', null, t('models.cost')),
          h('th', null, t('models.input')),
          h('th', null, t('models.cacheRead')),
          h('th', null, t('models.output')),
          h('th', null, t('models.steps')),
        )),
        h('tbody', null, props.rows.map((row) => h('tr', { key: row.day },
          h('td', null, row.day),
          h('td', null, usd(row.cost)),
          h('td', null, tokens(row.input)),
          h('td', null, tokens(row.cacheRead)),
          h('td', null, tokens(row.output)),
          h('td', null, plain.format(row.steps)),
        ))),
      );
    }

    /** Provider rows with their current state. */
    function ProviderList(props) {
      const t = props.t;
      return h('ul', { className: 'dsu-list' },
        props.rows.map((row) => h('li', { key: row.id },
          h('span', null, row.label),
          h('span', { className: 'dsu-tag' }, statusLabel(t, row.status)),
          h('span', { className: 'dsu-muted' }, row.note),
        )),
      );
    }

    /** The page. */
    function UsagePage(props) {
      const t = props.t;
      const api = props.api;
      const [state, setState] = React.useState({ phase: 'loading', report: null, error: null });

      // Re-assert the head stylesheet after every render. It is idempotent and
      // costs one querySelector, and it means the panel heals itself within one
      // refresh cycle no matter what empties or detaches the tag.
      React.useEffect(() => { injectStyles(); });

      const load = React.useCallback(async (refresh) => {
        setState((current) => ({ ...current, phase: current.report === null ? 'loading' : 'refreshing' }));
        const result = await api.summary(refresh === true);
        if (result.ok) setState({ phase: 'ready', report: result.value, error: null });
        else setState((current) => ({ phase: 'error', report: current.report, error: result.error }));
      }, [api]);

      React.useEffect(() => {
        let cancelled = false;
        const run = async (refresh) => {
          if (cancelled) return;
          await load(refresh);
        };
        run(false);
        const timer = setInterval(() => { run(false); }, REFRESH_MS);
        return () => { cancelled = true; clearInterval(timer); };
      }, [load]);

      const report = state.report;
      const busy = state.phase === 'loading' || state.phase === 'refreshing';

      return h('div', { className: 'dsu-page' },
        h('div', { className: 'dsu-head' },
          h('div', null,
            h('h1', null, t('page.title')),
            h('p', { className: 'dsu-sub' }, report === null
              ? t('page.subtitle')
              : fill(t('page.asOf'), { time: clock(report.generatedAt) })),
          ),
          h('button', {
            type: 'button',
            className: 'dsu-btn',
            disabled: busy,
            onClick: () => { void load(true); },
          }, busy ? t('page.loading') : t('page.refresh')),
        ),

        state.phase === 'error' && state.error !== null
          ? h('div', { className: 'dsu-error' }, fill(t('page.error'), { message: state.error.message }))
          : null,

        h(BalanceCard, {
          t,
          balance: report?.balance ?? null,
          credentialRef: report?.credentialRef ?? 'DEEPSEEK_API_KEY',
        }),

        report === null ? null : h('div', { className: 'dsu-section' }, h(SpendCards, { t, spend: report.spend })),

        report === null ? null : h('div', { className: 'dsu-section' },
          h('h2', null, t('tokens.title')),
          h(TokenGrid, { t, tokens: report.tokens }),
        ),

        report === null ? null : h('div', { className: 'dsu-section' },
          h('h2', null, t('models.title')),
          h(ModelTable, { t, rows: report.byModel }),
        ),

        report === null || report.byDay.length === 0 ? null : h('div', { className: 'dsu-section' },
          h('h2', null, t('days.title')),
          h(DayTable, { t, rows: report.byDay }),
        ),

        report === null ? null : h('div', { className: 'dsu-section' },
          h('h2', null, t('providers.title')),
          h(ProviderList, { t, rows: report.providers }),
        ),

        report === null ? null : h('div', { className: 'dsu-foot' },
          h('div', null, report.scan.files === 0
            ? fill(t('scan.none'), { root: report.scan.root })
            : fill(t('scan.summary'), {
              files: report.scan.files,
              ms: report.scan.ms,
              cached: report.scan.cached,
            })),
          h('div', null, fill(t('price.note'), {
            verified: report.price.verified,
            unit: report.price.unit,
            peakHours: report.price.peakHours,
          }), ' ', h('a', {
            href: report.price.source,
            target: '_blank',
            rel: 'noreferrer',
          }, t('price.source'))),
        ),
      );
    }

    /** The sidebar entry's mark. */
    function UsageIcon() {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('path', { d: 'M4 19h16' }),
        h('path', { d: 'M6 19V9' }),
        h('path', { d: 'M11 19V5' }),
        h('path', { d: 'M16 19v-7' }),
      );
    }

    // ---------------------------------------------------------------------
    // Plugin body
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale', 'remote'],
      apply(ctx) {
        // Head-injected once, so the sheet outlives every remount of the panel.
        injectStyles();
        ctx.effect(() => ctx.locale.register(NS, { en }), 'usage: dictionaries');
        const t = ctx.locale.bind(NS);

        const mount = acquireMount(ctx);
        ctx.effect(() => () => mount.release(), 'usage: remote namespace');

        /** Call `summary` on the Host, waiting for the namespace first. */
        const api = {
          async summary(refresh) {
            try {
              const service = await mount.ready;
              return await invoke(service, 'summary', refresh === true ? { refresh: true } : {});
            } catch (error) {
              return failure(`${PACKAGE}/namespace`, String(error?.message ?? error));
            }
          },
        };

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t, api }),
        }, UsagePage));

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          locale: NS,
          label: () => t('panel'),
        }, UsageIcon));
      },
    };
  },
});
