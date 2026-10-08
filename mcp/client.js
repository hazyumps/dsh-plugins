/**
 * MCP — the browser half.
 *
 * A classic-script DSH client plugin: it mounts the `mcp` Remote namespace
 * (the same descriptor ids the Host registers through `./typert`), adds a
 * sidebar entry, and renders one card per MCP server.
 *
 * Ground rules this file follows (recon-client.md §2, §4, §5, §9):
 *   - `id` MUST equal the package name or the loader row never resolves.
 *   - No `import`, no bundler, and never `require` an `@deepseek-ai/dsh-client-*`
 *     package: a throw there blanks the slot entry silently.
 *   - `main` takes `key`; `sidebar.panellist` takes `id`. Swapping them throws.
 *   - Everything visible goes through `ctx.locale` and theme tokens.
 *
 * The per-server label, accent hue and glyph live here rather than on the wire:
 * they are presentation, and a server this file has never heard of still renders
 * with a neutral plug mark and its own name.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-mcp',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PACKAGE = 'dsh-plugin-mcp';
    const NAMESPACE = 'mcp';
    const NS = 'mcp';
    const PANEL_ID = 'mcp';
    const NAMESPACE_TIMEOUT_MS = 10_000;
    const REFRESH_MS = 20_000;

    // ---------------------------------------------------------------------
    // Locale
    // ---------------------------------------------------------------------

    const en = {
      'panel': 'MCP',
      'page.title': 'MCP servers',
      'page.subtitle': 'Live from the Loader: what each server is, where it points, and what it is contributing right now.',
      'page.refresh': 'Refresh',
      'page.loading': 'Reading…',
      'page.asOf': 'as of {time}',
      'page.error': 'Could not read the MCP servers: {message}',
      'stats.servers': 'Servers',
      'stats.active': 'Active',
      'stats.tools': 'Tools',
      'stats.off': 'Off',
      'stats.failed': 'Failed',
      'state.active': 'active',
      'state.idle': 'idle',
      'state.pending': 'pending',
      'state.loading': 'loading',
      'state.unloading': 'stopping',
      'state.failed': 'failed',
      'state.off': 'off',
      'transport.http': 'HTTP',
      'transport.stdio': 'stdio',
      'transport.other': 'other',
      'card.auth': 'auth',
      'card.tools': '{count} tools',
      'card.tool': '1 tool',
      'card.toolsUnknown': 'tool count unavailable',
      'card.timeout': '{seconds}s timeout',
      'card.noTarget': 'no endpoint reported',
      'empty.title': 'No MCP servers in this profile',
      'empty.body': 'gaia sync-dsh renders them from gaia/mcp.yml into the Harness home patch. If that file lists a server for dsh and this page is still empty, the row did not load — Settings → Built-in plugins → Plugin list shows why.',
      'foot.readOnly': 'Read-only. Servers are declared in gaia/mcp.yml and rendered into the Harness home patch.',
      'foot.failed': 'A failed row keeps its last tool set but is not reachable until it reconnects.',
    };

    // ---------------------------------------------------------------------
    // Presentation registry
    // ---------------------------------------------------------------------

    /**
     * One mark per server name, drawn on a 24×24 grid with strokes only.
     * `accent` tints both the glyph and its chip background.
     */
    const MARKS = {
      search: {
        label: 'Search',
        note: 'Web search and page reading',
        accent: '#35b8c9',
        draw: [
          ['circle', { cx: 11, cy: 11, r: 6 }],
          ['path', { d: 'M15.6 15.6 20 20' }],
        ],
      },
      diagram: {
        label: 'Diagrams',
        note: 'Render diagrams to images',
        accent: '#f2a65a',
        draw: [
          ['circle', { cx: 12, cy: 5.5, r: 2.5 }],
          ['circle', { cx: 5.5, cy: 18, r: 2.5 }],
          ['circle', { cx: 18.5, cy: 18, r: 2.5 }],
          ['path', { d: 'M10.8 7.6 6.8 15.6' }],
          ['path', { d: 'M13.2 7.6 17.2 15.6' }],
        ],
      },
      unraid: {
        label: 'Unraid',
        note: 'The NAS: array, containers, VMs',
        accent: '#e0685f',
        draw: [
          ['rect', { x: 3, y: 4, width: 18, height: 5, rx: 1.5 }],
          ['rect', { x: 3, y: 11, width: 18, height: 5, rx: 1.5 }],
          ['path', { d: 'M7 6.5h.01' }],
          ['path', { d: 'M7 13.5h.01' }],
          ['path', { d: 'M3 19.5h18' }],
        ],
      },
      lab_power: {
        label: 'Lab power',
        note: 'Wake and sleep the lab hosts',
        accent: '#e0c055',
        draw: [
          ['path', { d: 'M12 3.5v8' }],
          ['path', { d: 'M7.4 7a7 7 0 1 0 9.2 0' }],
        ],
      },
      affine: {
        label: 'AFFiNE',
        note: 'Docs, tables and kanban',
        accent: '#7d8cf0',
        draw: [
          ['path', { d: 'm12 3 8 4.5-8 4.5-8-4.5z' }],
          ['path', { d: 'm4 12 8 4.5 8-4.5' }],
          ['path', { d: 'm4 16.5 8 4.5 8-4.5' }],
        ],
      },
      computer_use: {
        label: 'Computer use',
        note: 'Drive macOS apps through the AX tree',
        accent: '#4dc9a5',
        draw: [
          ['rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }],
          ['path', { d: 'M9.5 20h5' }],
          ['path', { d: 'M12 16v4' }],
          ['path', { d: 'M10.5 8.5 16 10.4l-2.2.9-.9 2.2z' }],
        ],
      },
      ms365_outlook: {
        label: 'Outlook',
        note: 'Mail and calendar',
        accent: '#4b93f0',
        draw: [
          ['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }],
          ['path', { d: 'm3.6 7.2 8.4 6 8.4-6' }],
        ],
      },
      ms365_teams: {
        label: 'Teams',
        note: 'Chats and channels',
        accent: '#a78bfa',
        draw: [
          ['circle', { cx: 9, cy: 8, r: 3 }],
          ['path', { d: 'M3.5 19a5.5 5.5 0 0 1 11 0' }],
          ['path', { d: 'M16 6.4a3 3 0 0 1 0 5.9' }],
          ['path', { d: 'M17.6 14.3A5.5 5.5 0 0 1 20.5 19' }],
        ],
      },
      ms365_sharepoint: {
        label: 'SharePoint',
        note: 'Sites, lists and files',
        accent: '#37a8a0',
        draw: [
          ['circle', { cx: 18, cy: 5.5, r: 2.5 }],
          ['circle', { cx: 6, cy: 12, r: 2.5 }],
          ['circle', { cx: 18, cy: 18.5, r: 2.5 }],
          ['path', { d: 'M8.3 10.7 15.7 6.6' }],
          ['path', { d: 'm8.3 13.3 7.4 4.1' }],
        ],
      },
      ynab: {
        label: 'YNAB',
        note: 'Budgets and accounts',
        accent: '#5fc26a',
        draw: [
          ['rect', { x: 3, y: 6, width: 18, height: 13, rx: 2.5 }],
          ['path', { d: 'M3 10.5h18' }],
          ['circle', { cx: 16.5, cy: 15, r: 1.2 }],
        ],
      },
      nst: {
        label: 'NST',
        note: 'Training Nexus: cohort and field readiness',
        accent: '#ef7fb0',
        draw: [
          ['path', { d: 'm12 4 9 4.5-9 4.5-9-4.5z' }],
          ['path', { d: 'M7 11v4.6c0 1.4 2.2 2.4 5 2.4s5-1 5-2.4V11' }],
          ['path', { d: 'M21 8.5v5' }],
        ],
      },
    };

    /** What an unknown server looks like: a plug, and no invented description. */
    const FALLBACK_MARK = {
      label: null,
      note: null,
      accent: '#8a8f98',
      draw: [
        ['path', { d: 'M9 3v4' }],
        ['path', { d: 'M15 3v4' }],
        ['path', { d: 'M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0z' }],
        ['path', { d: 'M12 16v5' }],
      ],
    };

    /**
     * The mark and copy for one server name.
     * @param serverName - The MCP server namespace.
     * @returns A registry entry, or the neutral plug.
     */
    function markOf(serverName) {
      return MARKS[serverName] ?? FALLBACK_MARK;
    }

    /**
     * A display name for a server this file does not know.
     * @param serverName - The MCP server namespace.
     * @returns Title-cased text with underscores read as spaces.
     */
    function titleCase(serverName) {
      const words = String(serverName).split(/[_\s]+/).filter((word) => word.length > 0);
      if (words.length === 0) return String(serverName);
      return words
        .map((word) => (word === word.toUpperCase() && word.length > 1
          ? word
          : word.charAt(0).toUpperCase() + word.slice(1)))
        .join(' ');
    }

    /** Convert an accent hex to an `rgba()` chip background. */
    function tint(hex, alpha) {
      const value = hex.replace('#', '');
      const full = value.length === 3 ? value.split('').map((part) => part + part).join('') : value;
      const number = Number.parseInt(full, 16);
      if (!Number.isFinite(number)) return `rgba(138, 143, 152, ${alpha})`;
      const r = (number >> 16) & 255;
      const g = (number >> 8) & 255;
      const b = number & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    // ---------------------------------------------------------------------
    // Formatting
    // ---------------------------------------------------------------------

    const plain = new Intl.NumberFormat('en-US');

    /** Fill `{name}` placeholders. */
    function fill(text, values) {
      return String(text).replace(/\{(\w+)\}/g, (_match, key) => (
        values[key] === undefined ? '' : String(values[key])
      ));
    }

    /** Clock time from epoch milliseconds. */
    function clock(value) {
      if (typeof value !== 'number' || value <= 0) return '—';
      return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    /** The pill word and tone for one row. */
    function stateOf(row) {
      if (row.enabled !== true) return { tone: 'off', label: 'state.off' };
      if (row.phase === 'active') return { tone: 'ok', label: 'state.active' };
      if (row.phase === 'failed') return { tone: 'error', label: 'state.failed' };
      if (row.phase === 'pending' || row.phase === 'loading' || row.phase === 'unloading') {
        return { tone: 'busy', label: `state.${row.phase}` };
      }
      return { tone: 'idle', label: 'state.idle' };
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
        id: `${PACKAGE}#${NAMESPACE}/list`,
        service: NAMESPACE,
        namespace: NAMESPACE,
        method: 'list',
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: strictCodec('ListRequest'),
        }],
        result: strictCodec('ListResult'),
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
      .dsm-page {
        height: 100%; min-height: 0; overflow: auto;
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
        font-size: 14px; line-height: 1.6;
        padding: 28px clamp(20px, 4vw, 48px) 48px;
      }
      .dsm-head {
        display: flex; align-items: flex-start; justify-content: space-between;
        gap: 16px; margin-bottom: 18px;
      }
      .dsm-head h1 { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; }
      .dsm-sub { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; max-width: 62ch; }
      .dsm-btn {
        height: 32px; padding: 0 14px; border: none; cursor: pointer;
        border-radius: var(--dsw-radius-md);
        font-size: 13px; line-height: 20px;
        color: var(--dsw-alias-label-primary-foreground);
        background: var(--dsw-alias-button-primary-fill);
        white-space: nowrap;
      }
      .dsm-btn:hover { background: var(--dsw-alias-button-primary-hover); }
      .dsm-btn[disabled] { opacity: 0.6; cursor: default; }
      .dsm-btn:focus-visible {
        outline: var(--dsw-focus-ring-width) solid
          var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 2px;
      }
      .dsm-stats {
        display: grid; gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
        margin-bottom: 22px;
      }
      .dsm-stat {
        border: 0.5px solid var(--dsw-alias-border-l3);
        border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-bg-layer-1);
        padding: 10px 14px; min-width: 0;
      }
      .dsm-stat-label {
        font-size: 12px; letter-spacing: 0.02em; text-transform: uppercase;
        color: var(--dsw-alias-label-tertiary);
      }
      .dsm-stat-value { font-size: 20px; font-weight: 500; line-height: 28px; }
      .dsm-stat[data-tone="error"] .dsm-stat-value { color: var(--dsw-alias-state-error-primary, inherit); }
      .dsm-grid {
        display: grid; gap: 12px;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      }
      .dsm-card {
        display: flex; gap: 12px; min-width: 0;
        border: 0.5px solid var(--dsw-alias-border-l3);
        border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-bg-layer-1);
        padding: 14px;
        transition: border-color 120ms ease, background 120ms ease;
      }
      .dsm-card:hover {
        border-color: var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-layer-2);
      }
      .dsm-card[data-state="off"] { opacity: 0.62; }
      .dsm-card[data-state="off"]:hover {
        border-color: var(--dsw-alias-border-l3);
        background: var(--dsw-alias-bg-layer-1);
      }
      .dsm-card[data-state="failed"] { border-color: var(--dsw-alias-state-error-primary, var(--dsw-alias-border-l3)); }
      .dsm-chip {
        flex: 0 0 auto; width: 36px; height: 36px;
        display: flex; align-items: center; justify-content: center;
        border-radius: var(--dsw-radius-md);
      }
      .dsm-body { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; gap: 3px; }
      .dsm-row { display: flex; align-items: center; gap: 8px; }
      .dsm-name { font-size: 14px; font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsm-desc { margin: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
      .dsm-pill {
        margin-left: auto; flex: 0 0 auto;
        font-size: 11px; line-height: 16px; padding: 1px 8px; border-radius: 999px;
        border: 0.5px solid var(--dsw-alias-border-l3);
        color: var(--dsw-alias-label-tertiary);
      }
      .dsm-pill[data-tone="ok"] {
        color: var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary));
        border-color: color-mix(in srgb, currentColor 45%, transparent);
      }
      .dsm-pill[data-tone="error"] {
        color: var(--dsw-alias-state-error-primary);
        border-color: color-mix(in srgb, currentColor 45%, transparent);
      }
      .dsm-pill[data-tone="busy"] { color: var(--dsw-alias-state-warn-primary); }
      .dsm-meta {
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
        font-size: 12px; color: var(--dsw-alias-label-tertiary);
      }
      .dsm-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .dsm-sep { opacity: 0.5; }
      .dsm-target {
        margin-top: 4px; padding: 5px 8px;
        border-radius: var(--dsw-radius-sm);
        background: var(--dsw-alias-bg-layer-2);
        border: 0.5px solid var(--dsw-alias-border-l2);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px; color: var(--dsw-alias-label-secondary);
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .dsm-target[data-empty="true"] { color: var(--dsw-alias-label-tertiary); font-family: inherit; }
      .dsm-foot {
        display: flex; gap: 12px; margin-top: 6px;
        font-size: 12px; color: var(--dsw-alias-label-tertiary);
      }
      .dsm-empty {
        border: 0.5px dashed var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-lg);
        padding: 28px; text-align: center; color: var(--dsw-alias-label-tertiary);
      }
      .dsm-empty strong { display: block; color: var(--dsw-alias-label-primary); font-weight: 500; margin-bottom: 4px; }
      .dsm-empty p { margin: 0 auto; max-width: 56ch; font-size: 13px; }
      .dsm-error {
        border: 0.5px solid var(--dsw-alias-state-error-primary, var(--dsw-alias-border-l3));
        border-radius: var(--dsw-radius-md);
        padding: 10px 12px; margin-bottom: 16px; font-size: 13px;
      }
      .dsm-loading { color: var(--dsw-alias-label-tertiary); padding: 12px 0; }
      .dsm-foot-note {
        margin-top: 28px; font-size: 12px; color: var(--dsw-alias-label-tertiary);
        display: flex; flex-direction: column; gap: 2px;
      }
      @media (prefers-reduced-motion: reduce) {
        .dsm-card { transition: none; }
      }
    `;

    // ---------------------------------------------------------------------
    // Stylesheet
    // ---------------------------------------------------------------------

    /**
     * Inject the panel stylesheet once, into `document.head`.
     *
     * Deliberately *not* a child of the component: a component-rendered
     * `<style>` dies with whatever subtree React tears down when the panel is
     * remounted, and the markup then keeps working while rendering unstyled.
     * The shipped client plugins do the same — one tag per CSS module, keyed on
     * `data-plugin-css`, appended to the head.
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

    /** The traced mark for one server, or the neutral plug. */
    function Glyph(props) {
      const mark = props.mark;
      const size = props.size ?? 20;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      }, mark.draw.map(([tag, attributes], index) => h(tag, { key: index, ...attributes })));
    }

    /** One headline number. */
    function Stat(props) {
      return h('div', { className: 'dsm-stat', 'data-tone': props.tone },
        h('div', { className: 'dsm-stat-label' }, props.label),
        h('div', { className: 'dsm-stat-value' }, props.value),
      );
    }

    /** One MCP server. */
    function ServerCard(props) {
      const t = props.t;
      const row = props.row;
      const mark = markOf(row.serverName);
      const state = stateOf(row);
      const name = mark.label ?? titleCase(row.serverName);
      const toolLabel = row.toolCount === null
        ? t('card.toolsUnknown')
        : row.toolCount === 1
          ? t('card.tool')
          : fill(t('card.tools'), { count: plain.format(row.toolCount) });

      return h('article', {
        className: 'dsm-card',
        'data-state': row.enabled ? (row.phase === 'failed' ? 'failed' : 'on') : 'off',
      },
        h('div', {
          className: 'dsm-chip',
          style: { background: tint(mark.accent, 0.16), color: mark.accent },
        }, h(Glyph, { mark })),

        h('div', { className: 'dsm-body' },
          h('div', { className: 'dsm-row' },
            h('span', { className: 'dsm-name', title: row.serverName }, name),
            h('span', { className: 'dsm-pill', 'data-tone': state.tone }, t(state.label)),
          ),

          mark.note === null ? null : h('p', { className: 'dsm-desc' }, mark.note),

          h('div', { className: 'dsm-meta' },
            h('span', { className: 'dsm-mono' }, row.serverName),
            h('span', { className: 'dsm-sep' }, '·'),
            h('span', null, t(`transport.${row.transport}`)),
            row.authenticated ? h('span', { className: 'dsm-sep' }, '·') : null,
            row.authenticated ? h('span', null, t('card.auth')) : null,
          ),

          h('div', {
            className: 'dsm-target',
            'data-empty': row.target.length === 0 ? 'true' : 'false',
            title: row.target,
          }, row.target.length === 0 ? t('card.noTarget') : row.target),

          h('div', { className: 'dsm-foot' },
            h('span', null, toolLabel),
            row.timeoutMs === null
              ? null
              : h('span', null, fill(t('card.timeout'), { seconds: Math.round(row.timeoutMs / 1000) })),
          ),
        ),
      );
    }

    /** The page. */
    function McpPage(props) {
      const t = props.t;
      const api = props.api;
      const [state, setState] = React.useState({ phase: 'loading', report: null, error: null });

      // Re-assert the head stylesheet after every render. It is idempotent and
      // costs one querySelector, and it means the panel heals itself within one
      // refresh cycle no matter what empties or detaches the tag.
      React.useEffect(() => { injectStyles(); });

      const load = React.useCallback(async () => {
        setState((current) => ({ ...current, phase: current.report === null ? 'loading' : 'refreshing' }));
        const result = await api.list();
        if (result.ok) setState({ phase: 'ready', report: result.value, error: null });
        else setState((current) => ({ phase: 'error', report: current.report, error: result.error }));
      }, [api]);

      React.useEffect(() => {
        let cancelled = false;
        const run = async () => {
          if (cancelled) return;
          await load();
        };
        run();
        const timer = setInterval(() => { run(); }, REFRESH_MS);
        return () => { cancelled = true; clearInterval(timer); };
      }, [load]);

      const report = state.report;
      const busy = state.phase === 'loading' || state.phase === 'refreshing';
      const totals = report?.totals ?? null;

      const stats = [];
      stats.push(h(Stat, { key: 'servers', label: t('stats.servers'), value: totals === null ? '—' : plain.format(totals.servers) }));
      stats.push(h(Stat, { key: 'active', label: t('stats.active'), value: totals === null ? '—' : plain.format(totals.active) }));
      stats.push(h(Stat, { key: 'tools', label: t('stats.tools'), value: totals === null || totals.tools === null ? '—' : plain.format(totals.tools) }));
      if (totals !== null && totals.failed > 0) {
        stats.push(h(Stat, { key: 'failed', label: t('stats.failed'), value: plain.format(totals.failed), tone: 'error' }));
      } else {
        stats.push(h(Stat, { key: 'off', label: t('stats.off'), value: totals === null ? '—' : plain.format(totals.servers - totals.enabled) }));
      }

      return h('div', { className: 'dsm-page' },
        h('div', { className: 'dsm-head' },
          h('div', null,
            h('h1', null, t('page.title')),
            h('p', { className: 'dsm-sub' }, t('page.subtitle')),
          ),
          h('button', {
            type: 'button',
            className: 'dsm-btn',
            disabled: busy,
            onClick: () => { void load(); },
          }, busy ? t('page.loading') : t('page.refresh')),
        ),

        state.phase === 'error' && state.error !== null
          ? h('div', { className: 'dsm-error' }, fill(t('page.error'), { message: state.error.message }))
          : null,

        h('div', { className: 'dsm-stats' }, stats),

        report === null
          ? h('p', { className: 'dsm-loading' }, t('page.loading'))
          : (report.servers.length === 0
            ? h('div', { className: 'dsm-empty' },
              h('strong', null, t('empty.title')),
              h('p', null, t('empty.body')))
            : h('div', { className: 'dsm-grid' },
              report.servers.map((row) => h(ServerCard, { key: row.id || row.serverName, t, row })))),

        h('div', { className: 'dsm-foot-note' },
          h('div', null, t('foot.readOnly')),
          totals !== null && totals.failed > 0 ? h('div', null, t('foot.failed')) : null,
          report === null ? null : h('div', null, fill(t('page.asOf'), { time: clock(report.generatedAt) })),
        ),
      );
    }

    /** The sidebar entry's mark. */
    function McpIcon() {
      return h(Glyph, { mark: FALLBACK_MARK, size: 16 });
    }

    // ---------------------------------------------------------------------
    // Plugin body
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'locale', 'remote'],
      apply(ctx) {
        // Head-injected once, so the sheet outlives every remount of the panel.
        injectStyles();
        ctx.effect(() => ctx.locale.register(NS, { en }), 'mcp: dictionaries');
        const t = ctx.locale.bind(NS);

        const mount = acquireMount(ctx);
        ctx.effect(() => () => mount.release(), 'mcp: remote namespace');

        /** Call `list` on the Host, waiting for the namespace first. */
        const api = {
          async list() {
            try {
              const service = await mount.ready;
              return await invoke(service, 'list', {});
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
        }, McpPage));

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: () => t('panel'),
        }, McpIcon));
      },
    };
  },
});
