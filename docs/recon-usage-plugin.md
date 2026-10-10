# Build recipe — DSH "Usage" plugin (DeepSeek balance + token spend)

Recon of the **installed** DSH 0.2.0-rc.2 asar
(`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`, packages under
`/dsh/node_modules/@deepseek-ai/`), cross-checked against the working
`dsh-plugin-whale-pet@0.2.9` installed in `~/.dsh/profiles/desktop`. Recon date
2026-10-07. Extraction: `node /tmp/asarx/x.js "/dsh/node_modules/@deepseek-ai/<pkg>" /tmp/recon/<pkg>`.

Sibling recon: `docs/recon-client.md` (client/slots/remotes) and
`docs/recon-host.md` (host services) are accurate where relied on here;
corrections are noted inline.

## 0. Verdict up front

| # | Question | Verdict |
|---|---|---|
| 1 | Sidebar "Usage" panel | **Proven.** `main` keyed slot + `sidebar.panellist` list slot, same `PANEL_ID`. Whale-pet and ui-schedule both do exactly this. |
| 2 | Host service: credential → HTTPS GET → hand-written Typert Remote | **Proven.** `ctx.credentials.resolve(credentialRef('DEEPSEEK_API_KEY'))`; `./typert` export auto-registered by `dsh-typert-loader`; client `ctx.remote.$mount(...)`. Whale-pet ships a working hand-written manifest. |
| 3 | Token accounting | **Feasible, with one real gap.** Per-session and per-attempt usage are persisted in the session log with the model id; per-session totals come free via the `tokenUsage` projection. **No cross-session aggregate exists** — the plugin must fold `sessionQuery.readSession()` over all sessions itself. Estimated $ is computable (price table is plugin-side; DSH has no pricing API). |
| 4 | Install | Two rows in the profile: pnpm dependency + loader row. Installable from a repo path via the loader (`name` accepts an absolute path) or as an installed bundle. |
| 5 | Extensibility | One config-declared provider table (credential ref + balance endpoint + price table); usage accounting is provider-agnostic for free because the session log tags every request with `provider`/`model`. |

**Blocker worth knowing before building:** `ctx.remote.$on(...)` forwarded events
are a hard-coded Host allowlist (`API_REMOTE_FORWARDED_EVENTS` in
`dsh-api-remotes`) — a plugin **cannot** add a push event. Live updates are
either client-side polling of a unary remote, or a plugin-owned **stream**
method (whale-pet's pattern). Polling is the smallest correct answer.

---

## 1. Client — the "Usage" panel

### 1.1 The two slot registrations

From `dsh-client-ui-schedule/lib/client.js:6793-6810` (verified pattern, also in
whale-pet): the sidebar entry and the panel are **two registrations sharing one
string id**. `main` is declared *keyed, root scope* by `dsh-client-ui-layout`
(`lib/client.js:601-627`); `sidebar.panellist` is declared *list, root scope* by
`dsh-client-ui-sidebar` (`lib/client.js:503`).

```js
const PANEL_ID = "usage";

// panel body — keyed slot → options.key
ctx.slots.inject("main", () => ctx.slots.register({
  name: "main", key: PANEL_ID, locale: NS, inject: () => ({ ...props }),
}, UsagePage));

// sidebar entry — list slot → options.id
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist", id: PANEL_ID, order: 15, locale: NS,
  label: () => t("panel"),
}, UsageIcon));
```

Contract (`dsh-client-ui-sidebar/README.md:38`): matching `id`/`key` is the whole
wiring — the sidebar owns the click and calls `ctx.layout.selectPanel(id)`
itself. **Register the icon component into `sidebar.panellist`, not a row**; the
host renders the row, label, and selection state. Getting `key`/`id` backwards
throws at registration.

### 1.2 Client module format

`client.js` is a **classic script**, not an ES module. One call to
`window.__ModuleLoader__.load({ id, factory })`; `id` **must equal the package
name**; the returned object is `{ inject, apply }`. `inject` is a flat array of
service keys; the plugin stays inactive until all exist (graceful degradation,
not an error). Whale-pet's returned module (`lib/client.js:2500`):

```js
inject: ['slots', 'sessions', 'connection', 'locale', 'remote'],
```

`dsh.client` in `package.json` (validated by `dsh-client-modules/lib/index.js:63-73`;
whale-pet's is the template):

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-api-gateway",
               "@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-ui-renderer",
               "@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-primitives"]
  }
}
```

- `platform: "web"` — required to load in the Web GUI. `immediately: true` is
  optional (load at boot vs lazily). `inject` lists other packages' **names**
  (activation ordering only).
- A package declaring `dsh.client` must export `./client` or activation fails.
- **Never import `@deepseek-ai/dsh-client-ui-*` from plugin code**
  (`references/practices.md`; also `docs/recon-client.md` §B5). Copy markup and
  use only `--dsw-alias-*`/`--dsw-radius-*`/`--dsw-focus-ring-*` tokens.

### 1.3 Requesting data from the host + polling/refresh

The remote call (`docs/recon-client.md` §5.1, verified against
`dsh-api-gateway/lib/client.js`): inject `"remote"` and `"remote.<namespace>"`,
then `ctx.remote.<ns>.<method>(args)` resolves (never rejects) to
`{ ok: true, value } | { ok: false, error: { code, message } }`. Discriminate on
`error.code`, never `instanceof`.

**Push events are not available to plugins** — `ctx.remote.$on` keys are exactly
the Host's forwarding allowlist. So:

- **Poll** a unary method on an interval inside the React component; clear the
  timer in the effect cleanup. For a balance/usage monitor a 60–300 s cadence is
  right (DeepSeek's balance endpoint is not high-frequency).
- **Re-read after reconnect**: subscribe `ctx.on("connection/reset", fn)` (the
  pattern ui-schedule's `createCatalogSource` uses,
  `lib/client.js:6714-6761`), and refresh after `session/changed`-style
  activity if desired — but note usage totals change during a turn, so tie the
  refresh cadence to turn-end visibility rather than streaming.
- If true push is ever wanted, copy whale-pet's **stream** method
  (`mode: "stream"`, `cancellation: { parameter: "signal" }`,
  `AsyncIterable` result) — but it is a second lease/mount lifecycle to own
  (`acquireWhaleRemote`, `lib/client.js:2180-2240`). Not needed for v1.

React is available via `require("react")` and `require("react/jsx-runtime")`
from the frozen platform-module seed table; whale-pet uses plain
`React.createElement` with no build step.

### 1.4 Minimal complete client.js (polling balance + usage)

```js
// client.js — classic script; id MUST equal the package name
window.__ModuleLoader__.load({
  id: "dsh-plugin-usage",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const NS = "usage";
    const PANEL_ID = "usage";

    const en = {
      "panel": "Usage",
      "page.title": "Usage",
      "balance.label": "DeepSeek balance",
      "usage.session": "This session",
      "usage.all": "All sessions (est.)",
      "error.none": "No API key configured.",
    };

    const CSS = `
      .usage-page { height: 100%; min-height: 0; overflow: auto;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
        font-size: 14px; line-height: 1.6; padding: 28px clamp(24px, 4vw, 48px) 48px; }
      .usage-card { padding: 16px; border: 0.5px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); }
      .usage-value { font-size: 24px; font-weight: 500; }
      .usage-dim { color: var(--dsw-alias-label-tertiary); }
    `;

    function UsagePage(props) {
      const t = props.t;
      const { usage, refresh } = props.hooks.usage;   // bound by the plugin body below
      return h("div", { className: "usage-page" },
        h("style", null, CSS),
        h("h1", null, t("page.title")),
        h("div", { className: "usage-card" },
          h("div", { className: "usage-dim" }, t("balance.label")),
          h("div", { className: "usage-value" },
            usage.ok ? `$${usage.balance.total_balance}` : usage.error),
          usage.ok ? null : h("div", { className: "usage-dim" }, t("error.none"))),
        h("button", { onClick: refresh }, "Refresh"));
    }

    function UsageIcon() {
      return h("svg", { viewBox: "0 0 24 24", width: 16, height: 16, fill: "none",
        stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true,
        style: { display: "block" } },
        h("circle", { cx: 12, cy: 12, r: 8 }), h("path", { d: "M12 8v4l3 2" }));
    }

    return {
      inject: ["slots", "locale", "remote", "remote.usage", "connection"],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en }), "usage: dictionaries");
        const t = ctx.locale.bind(NS);

        // Poll + reset-refresh source, exposed to the page as a React hook.
        const store = ctx.store({ usage: { ok: false, error: "loading" } });
        async function refresh() {
          const r = await ctx.remote.usage.snapshot();
          store.set({ usage: r.ok ? { ok: true, ...r.value } : { ok: false, error: r.error.code } });
        }
        const timer = setInterval(refresh, 60_000);
        const reset = () => refresh();
        ctx.on("connection/reset", reset);
        refresh();
        // cleanup for both is returned from the apply effect below

        ctx.slots.inject("main", () => ctx.slots.register({
          name: "main", key: PANEL_ID, locale: NS,
          inject: () => ({ t, hooks: { usage: { getSnapshot: () => store.getSnapshot().usage, refresh } } }),
        }, UsagePage));

        ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
          name: "sidebar.panellist", id: PANEL_ID, order: 15, locale: NS,
          label: () => t("panel"),
        }, UsageIcon));

        return () => { clearInterval(timer); };
      },
    };
  },
});
```

Notes easy to get wrong (all from ui-schedule/whale-pet):

- Everything inside `apply` registers through `ctx.effect(...)`/`ctx.on(...)`
  and returns cleanup. `ctx.slots.inject` and `ctx.locale.register` return
  disposers on their own.
- `main` takes `key`; `sidebar.panellist` takes `id`. Same string, both.
- Style with a `<style>` element inside the component (unmount removes it) or
  register CSS in an `apply` effect. Never touch `document.body` or the app root.
- `--dsw-alias-bg-layer-4` is referenced by shipped primitives CSS but
  **undefined** in the stylesheet — use `layer-3` (recon-client §9).
- A page in the main panel needs `height: 100%; min-height: 0; overflow: auto`
  to scroll inside the shell.

---

## 2. Host service — credential → HTTPS GET → Typert Remote

### 2.1 Read the API key

`@deepseek-ai/dsh-credentials` (README §"Storing, checking, and removing keys",
verified against `lib/types/index.js:28-40`):

```js
import { credentialRef } from "@deepseek-ai/dsh-credentials";

const ref = credentialRef("DEEPSEEK_API_KEY");            // branded POSIX shell identifier
const hit = await ctx.credentials.resolve(ref);           // { value, source } | undefined
const info = await ctx.credentials.describe(ref);         // { configured, source?, writable } — never the value
```

- The service is `ctx.credentials` (abstract `CredentialProvider extends
  Service`, `super(ctx, 'credentials')`, `dsh-credentials/lib/types/index.js:117`).
  The concrete store is `@deepseek-ai/dsh-credentials-local`, mounted in
  `dsh-base/cordis.patch.yml:117-118` as entry id `credentials` (backed by
  `$DSH_HOME/.credentials.yaml`, env over file, `.env` fallbacks —
  `dsh-base/cordis.patch.yml:105-107`). **Present in the desktop profile**, and
  `DEEPSEEK_API_KEY` is stored there (verified: `refs:` block in
  `~/.dsh/.credentials.yaml` contains the key name; value not read).
- The DSH web-search adapter uses exactly this reference (`apiKeyEnv:
  DEEPSEEK_API_KEY`, `dsh-base/cordis.patch.yml:481`).
- Resolving once per operation is the designed contract: a rotated key applies
  next call without restart (README Summary).
- `credentialRef` throws `TypeError` unless the name matches
  `/^[A-Za-z_][A-Za-z0-9_]*$/` — `DEEPSEEK_API_KEY` passes.

### 2.2 HTTPS GET with timeout

Node 22 global `fetch` + `AbortSignal.timeout` is enough and dependency-free:

```js
const response = await fetch("https://api.deepseek.com/user/balance", {
  method: "GET",
  headers: { Authorization: `Bearer ${hit.value}`, Accept: "application/json" },
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`deepseek balance ${response.status}`);
const body = await response.json();   // { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
```

DSH's own HTTP path uses `undici` `fetch` with `deadline`/`timeoutOf` from
`@deepseek-ai/dsh-timeout` (`dsh-web-fetch-http/lib/index.js:3,154-165`) —
copy that only if you want DSH-idiomatic timeouts; the global is fine for a
plugin. The verified endpoint per the parent brief returns total/granted/topped
up balance. The `account` remote's `getBalance`
(`dsh-api-account-controller/lib/index.js:221-226`) is **not** this: it is the
Platform *recharge wallet* for account-login grants and returns null for
API-key contexts (`README`: "Idle Agents and API-key contexts are excluded") —
do not route through it.

### 2.3 Expose it — hand-written Typert Remote (proven, not speculative)

`docs/recon-host.md` §7 claims the manual Typert path is proven. **Verified —
it is whale-pet's actual shipping mechanism**, both halves:

- **Host:** package `exports["./typert"]` is auto-registered by
  `dsh-typert-loader` on mount and withdrawn on unmount
  (`dsh-typert-loader/lib/index.js:7-31,300`; whale-pet `package.json`
  `"./typert": "./lib/typert.host.js"`).
- **Client:** the client module itself calls
  `remote.$mount({ package, descriptors })` — whale-pet
  `lib/client.js:2185`: `remote.$mount(WhaleBridgeContract.TYPERT_REMOTE)`,
  then uses the namespace in a **child fiber** via
  `ctx.inject(['remote.whalePet'], scope => scope.remote.whalePet)`
  (`lib/client.js:2236-2240`). `docs/recon-client.md` §B3 said only
  `dsh-api-remotes` mounts namespaces — that is **wrong/incomplete**: a plugin
  mounts its own, and the working install proves it.
- Never duplicate a Remote method across overlapping mounts; whale-pet guards
  with a `WeakMap` lease keyed on `ctx.root` (`lib/client.js:2183`).

**Service skeleton** (`lib/index.js`, whale-pet shape verbatim minus domain):

```js
export const name = "usage";
export const inject = ["credentials"];   // resolved per call, never cached

export function apply(ctx) {
  const service = {
    async balance(signal) {
      const hit = await ctx.credentials.resolve(credentialRef("DEEPSEEK_API_KEY"));
      if (!hit) throw Object.assign(new Error("DEEPSEEK_API_KEY is not set"), { code: "usage/credentials-absent" });
      const response = await fetch("https://api.deepseek.com/user/balance", {
        headers: { Authorization: `Bearer ${hit.value}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`deepseek balance ${response.status}`);
      return await response.json();
    },
    async snapshot(signal) {
      const [balance, usage] = await Promise.all([this.balance(signal), computeUsage(ctx)]);
      return { balance, usage };   // shape mirrored by the wire schema below
    },
  };
  service.typertRemote = Object.freeze({ service, serviceKey: name, namespace: name });
  ctx.provide(name, service);
}
```

(`service.typertRemote = Object.freeze({ service, serviceKey, namespace })` is
exactly `dsh-plugin-whale-pet/lib/index.js:101-112`; `bindTypertRemote(...)`
from `@deepseek-ai/dsh-typert-protocol` produces the same object,
`lib/index.js:146-170`.)

**`lib/typert.host.js` manifest** — the loader's validator
(`dsh-typert-loader/lib/index.js:77-205`) enforces: `package` === exporting
package name, `face === "host"`, `schemas[]` of `{ name, create(): schema }`,
`model.services[]` with `key`/`exportName`/`members[{kind,name,signature}]`,
every invocation with non-empty `id`/`service`/`namespace`/`method`,
`invocation.kind` in `direct|context`, unique parameter `wire`s, `source` in
`json|lookup`, and every codec `mode: "strict"` with `typeSymbol` + `create()`.
Unary + parameterized descriptor, copied from the schedule pattern
(`dsh-schedule/lib/typert.host.js:380-400`):

```js
import { z } from "zod";

const SnapshotResult = z.object({
  balance: z.object({
    is_available: z.boolean(),
    balance_infos: z.array(z.object({
      currency: z.string(),
      total_balance: z.string(),
      granted_balance: z.string(),
      topped_up_balance: z.string(),
    })),
  }),
  usage: z.object({
    sessions: z.array(z.object({
      sessionId: z.string(),
      totals: z.object({
        uncachedInputTokens: z.number().int(),
        outputTokens: z.number().int(),
        cacheReadTokens: z.number().int(),
        cacheWriteTokens: z.number().int(),
      }),
      byModel: z.array(z.object({
        provider: z.string(), model: z.string(),
        uncachedInputTokens: z.number().int(), outputTokens: z.number().int(),
        cacheReadTokens: z.number().int(), cacheWriteTokens: z.number().int(),
        requests: z.number().int(),
      })),
    })),
    asOf: z.string(),
  }),
});

const SNAPSHOT_DESCRIPTOR = {
  id: "dsh-plugin-usage#usage/snapshot",
  service: "usage", namespace: "usage", method: "snapshot",
  invocation: { kind: "direct" },
  parameters: [],
  cancellation: { parameter: "signal" },
  result: { mode: "strict", typeSymbol: "dsh-plugin-usage#UsageSnapshot", create: () => SnapshotResult },
};

export const TYPERT = {
  package: "dsh-plugin-usage", face: "host",
  schemas: [{ name: "UsageSnapshot", create: () => SnapshotResult }],
  invocations: [SNAPSHOT_DESCRIPTOR],
  model: { services: [{ key: "usage", exportName: "UsageService",
    description: "DeepSeek API-key balance and durable token-usage totals.", summary: "Usage", tags: [],
    members: [{ kind: "method", name: "snapshot", signature: "snapshot(signal?: AbortSignal): Promise<UsageSnapshot>" }],
    types: [] }], events: [], objects: [] },
};
export default TYPERT;
```

`package.json` gains `"./typert": "./lib/typert.host.js"` and
`"./remote": "./lib/remote.js"` (the client imports the descriptor object from
`./remote`, like whale-pet). **zod is safe to depend on** — it ships in the
app (`dsh-api-remotes` inlines zod 4.4.3) and in the shared profile tree
(`~/.dsh/profiles/node_modules/zod` exists).

**`cordis.patch.yml`** (whole file):

```yaml
- insert:
    - id: usage
      name: dsh-plugin-usage
      config: {}
```

**Where the numbers come from** — `computeUsage(ctx)` is §3.

---

## 3. Token accounting — what 0.2.0-rc.2 actually records

All findings below verified in the extracted packages.

### 3.1 Per-request / per-attempt, persisted, with model id — **yes**

- The durable session log carries **`request/header`** events whose
  `data.header.config` is `{ provider, model, reasoningEffort?, ... }`
  (`dsh-session/lib/index.js:1147`: seed validation *requires*
  `provider`/`model` non-empty strings on every header;
  `dsh-agent-loop/lib/index.js:1214-1225` appends one whenever the effective
  header changes or an attempt starts). So **the per-step model id is recorded
  next to the usage** — pair each usage-bearing message with the most recent
  preceding `request/header`.
- The log carries **`assistant/message`** events with
  `data.usage` = provider-reported usage and `data.turn`/`data.step`:
  `dsh-agent-loop/lib/index.js:1098` appends
  `{ turn, step, message: …(source: {provider: request.provider, model: request.model}), …, usage: live.usage, stream }`.
  Field buckets (verified `dsh-token-meter/lib/types/usage-projection.js:16-21`):
  `inputTokens` (= *uncached* input), `outputTokens`, optional
  `cacheReadTokens`, `cacheWriteTokens`. Retries contribute separate billed
  attempts (`llm/retry-started` ends the replacement scope).
- This is **persisted**: the events live in the durable log, replayable outside
  a live turn (`dsh-session-stats` README: "figures come from the complete
  durable log, so paging and compaction do not change them";
  `dsh-session-query` reads persisted logs via
  `ctx.sessionQuery.readSession(id)`).

### 3.2 Ready-made per-session aggregates

- **`ctx.tokenMeter`** (`@deepseek-ai/dsh-token-meter`, mounted in
  `dsh-base/cordis.patch.yml:338-339`): `measure(session)` for context pressure,
  and — the useful one — when `ctx.sessionProjections` exists it registers the
  **`tokenUsage`** projection unit with a client-visible wire view
  (`lib/types/usage-projection.js:47-75`): totals
  `{ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`
  over the whole durable log, plus `last: { turn, step, buckets }`.
- **`sessionStats`** (`@deepseek-ai/dsh-session-stats`, mounted in
  `dsh-web-app/cordis.patch.yml:102-103`): whole-session `turns/steps/llmMs/
  decodeMs/decodeTokens/...` — wall-time flavour, not billing; its
  `decodeTokens` is provider output tokens over usage-reporting steps.
- Both are readable from the client with **no plugin code at all**:
  `ctx.remote.session.projections({ sessionId })` →
  `{ asOfSeq, values: { tokenUsage: {...}, sessionStats: {...}, ... } }`
  (`dsh-api-session-controller/lib/typert.host.js`, `session/projections`
  descriptor; impl at `lib/index.js:3149` resolves through
  `ctx.sessionQuery.observeSession`, so **persisted (non-live) sessions work
  too**). This is the recommended per-session read for the panel.

### 3.3 Cross-session aggregate — **does not exist; build it**

- `tokenUsage` and `sessionStats` are per-session projection units. There is no
  aggregate across sessions anywhere in the asar (checked `dsh-token-meter`,
  `dsh-session-stats`, `dsh-session-query` — the latter is per-session reads
  plus full-text search, `README` "What you can do" table).
- **The plugin computes it**: host-side, inject `sessionQuery`
  (`@deepseek-ai/dsh-session-query`, backend `dsh-session-query-sqlite`
  mounted at `dsh-base/cordis.patch.yml:149-150`), then:

```js
import { credentialRef } from "@deepseek-ai/dsh-credentials";

async function computeUsage(ctx) {
  const sessions = await ctx.sessionQuery.listSessions();   // [{ id, live, persisted }, ...]
  const byModel = new Map();
  for (const { id } of sessions) {
    const events = (await ctx.sessionQuery.readSession(id)).events;  // replay-validated log
    let header;
    for (const event of events) {
      if (event.type === "request/header") header = event.data.header.config;
      if (event.type === "assistant/message" && event.data.usage && header) {
        const key = `${header.provider}/${header.model}`;
        const acc = byModel.get(key) ?? { provider: header.provider, model: header.model,
          uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
        acc.uncachedInputTokens += event.data.usage.inputTokens;
        acc.outputTokens += event.data.usage.outputTokens;
        acc.cacheReadTokens += event.data.usage.cacheReadTokens ?? 0;
        acc.cacheWriteTokens += event.data.usage.cacheWriteTokens ?? 0;
        acc.requests += 1;
        byModel.set(key, acc);
      }
    }
  }
  return [...byModel.values()];
}
```

- Caveat: `readSession()` returns the replay-validated raw log
  (`dsh-session-query` README); confirm the exact accessor name on the returned
  observation (events vs `events()`), **UNVERIFIED** — the README documents
  `readSession(id)` as "the complete replay-validated raw event log".
- Cheaper alternative for *current* sessions: read `tokenUsage`/`sessionStats`
  projections instead of folding raw events, and only fold logs for closed
  sessions.

### 3.4 Estimated $ spend

- **Computable**: tokens per model (above) × a plugin-side price table. DSH has
  **no pricing API** — `ctx.llm.resolveModelInfo()` returns context window,
  reasoning efforts, modalities (`dsh-llm` README / recon-host §2.3), never
  price. `ctx.tokenMeter` README is explicit: "Occupancy is a reference figure,
  not a billing record".
- DeepSeek published prices are cache-hit/cache-miss input + output; the
  `tokenUsage` buckets map cleanly (uncached input = cache-miss input;
  cacheReadTokens = cache-hit). Keep prices in provider config (§5) and label
  the $ figure "estimated".
- V3→V4 session-format migration (`dsh-session-format-v3-to-v4`): whether
  converted pre-upgrade sessions carry usage samples is **UNVERIFIED** — expect
  the all-time total to undercount sessions that predate the rc.2 install.

---

## 4. Packaging & install

### 4.1 What the profile needs

Two changes, both normally done by the plugin manager (never hand-edit while a
run is in flight — `dsh-plugin-manager/README.md`):

1. **Dependency** in `~/.dsh/profiles/desktop/package.json`:
   `"dsh-plugin-usage": "workspace:*"` (or a file/path spec). whale-pet is the
   template: it sits as a plain dependency of the profile
   (`profiles/desktop/package.json:5`), pnpm-installed with
   `nodeLinker: hoisted` (`profiles/desktop/pnpm-workspace.yaml`).
2. **Bundle activation**: a dependency whose manifest declares
   `dsh.bundle.patch` is appended to `dsh.profile.bundles` on the next
   manager operation ("New bundle dependencies activate automatically",
   `dsh-app-boot/lib/index.js:1102-1104`). The plugin manager tool path is
   `plugin_manager` action `install_bundle` with the absolute package dir
   (`dsh-plugin-manager/lib/types/tools.js:16`; recon-host §8) — it runs pnpm,
   then reconciles bundles. The `dsh plugin` CLI shares the same operations
   (`dsh-plugin-manager/README.md:92`).

⚠️ **Observed discrepancy:** `dsh-plugin-whale-pet@0.2.9` is pnpm-installed in
the desktop profile but **absent from `dsh.profile.bundles`** in
`profiles/desktop/package.json` — by `dsh-app-boot`'s
`enabled = bundles.includes(name)` rule it would be inactive in that profile
right now (maybe installed by hand, or toggled elsewhere). Use it as a
*template*; do not assume it is live.

### 4.2 Developing against this repo — **yes, two ways**

- **Loader rows accept an absolute path as `name`** ("Module specifier
  imported by the loader", `@cordisjs/plugin-loader` README Entry Options).
  Proof in the user's own home patch: `~/.dsh/cordis.patch.yml` inserts
  `gaia-cortex` with `name: /Users/you/repo/gaia/tools/dsh-cortex/index.mjs`.
  So during development:

  ```yaml
  # ~/.dsh/cordis.patch.yml (outside the gaia markers) or profiles/desktop/cordis.patch.yml
  - insert:
      - id: usage
        name: /Users/you/repo/dsh-plugins/dsh-plugin-usage/lib/index.mjs
  ```

  …pointing at a plain-ESM entry; no install needed, edits reload on restart
  (or via DSH HMR). Note the host half must be a real module the loader can
  import; the client half still needs the package to be resolvable for
  `dsh.client` serving — serving client bundles for a path-name entry is
  **UNVERIFIED** (gaia-cortex is host-only). If client serving fails, fall
  back to install_bundle with the repo dir as `target`.
- **install_bundle with a local path**: the manager accepts "the absolute
  package directory or spec" as `target` (recon-host §8) and an npm/tarball
  spec is validated against the DSH peer range before pnpm runs
  (`dsh-plugin-manager/README.md:63`) — declare
  `"peerDependencies": { "@deepseek-ai/dsh-base": … }` or ship a
  `COMPATIBILITY`/exemption as whale-pet does.

### 4.3 Importing harness packages from the plugin

> **Observed 2026-10-07 — this section does not hold for the desktop app.**
> A plugin installed into `~/.dsh/profiles/desktop` by path did **not** resolve
> its bare imports: the Host reported the entry as
> `failed to import`, and both specifiers reproduced `ERR_MODULE_NOT_FOUND` from
> the profile anchor (`@deepseek-ai/schemastery`, and `zod` too — a `link:`
> install does not install the package's own dependencies). The fix that works
> is structural: the Host half now imports only `node:` builtins and relative
> files, with a hand-rolled validator behind `codec.create().parse()`. Treat the
> two-anchor resolver patch described below as applying to the installation's own
> bundles, not to a path-linked plugin's dependencies. See the same trap in
> `../README.md`.

Host-side bare imports (`@deepseek-ai/dsh-credentials`,
`@deepseek-ai/dsh-session-query`, `zod`) resolve at runtime: profile boot
patches Node's ESM+CJS resolvers — "Module resolution is two-anchor by
construction: a bundle name resolves first from the dsh installation, then
from the profile directory… The runtime resolution supplies packages carried
by the installation and selected bundles to Node's ESM and CommonJS
resolvers" (`dsh-app-boot/lib/index.js:473-476`, resolver patch at `:1584`).
The same packages also exist on disk under
`~/.dsh/profiles/node_modules/@deepseek-ai/`. The desktop app's *exact* runtime
anchor was not observed live — **UNVERIFIED at runtime**, but both anchors
carry rc.2 packages.

---

## 5. Extensibility — the smallest provider seam

What the Host can actually reach: `ctx.credentials` (any named ref), `fetch`
(any endpoint), `ctx.llm` (`listProviders`/`listModels`/`resolveModelInfo` —
route metadata, **no pricing**), and provider-tagged usage in session logs
(provider-agnostic by construction — `request/header.config.provider/model`).

That yields a deliberately boring seam — a **provider table in the plugin's
Config** (Schemastery), one entry per provider:

```js
Config = {
  providers: [{
    id: "deepseek",                    // route key, also the credential-record scope
    displayName: "DeepSeek",
    credentialRef: "DEEPSEEK_API_KEY", // named ref resolved per call; empty → no balance
    balance: { url: "https://api.deepseek.com/user/balance",
               currencyPath: "balance_infos.0.currency",
               totalPath: "balance_infos.0.total_balance" },  // null → no balance query
    usage: { source: "dsh-sessions" }, // fold provider-tagged session logs
    pricePerMTokens: { inputUncached: 0.42, inputCached: 0.084, output: 1.68 },  // USD, plugin-side table
  }],
  refreshSeconds: 120,
}
```

Why this covers the roadmap without new machinery:

- **Other balances** = another `credentialRef` + `balance.url` (any
  bearer-header JSON endpoint; adapters per provider are just small response
  extractors). Credentials stay out of config by design.
- **Per-model usage/cost for every provider routed through DSH** — including
  `gaia-local` — is *already* provider-agnostic: the session fold in §3.3 keys
  on `header.config.provider`/`.model`, so the panel shows all routes with
  zero extra plumbing. Only *pricing* is per-provider, and that is the
  `pricePerMTokens` table (keep it visible as estimates).
- Adding a provider with a genuinely different API later = one adapter module
  selected by `balance.kind`; the Config table is the registry, no
  code-generation, no extra Typert namespaces (one `usage` namespace,
  `snapshot()` returns every configured provider).

---

## 6. Uncertainty register

| # | Item | Status |
|---|---|---|
| U1 | `sessionQuery.readSession()` return accessor for raw events (`.events` vs callable) | **UNVERIFIED** — README documents the operation; exact accessor read from code at build time. |
| U2 | Desktop app's live module-resolution anchor (asar vs `profiles/node_modules`) | **Resolved 2026-10-07: the anchor does not cover a path-linked plugin's bare imports.** Observed `failed to import` plus `ERR_MODULE_NOT_FOUND` for `@deepseek-ai/schemastery` and `zod` from the profile directory. Ship no bare imports. |
| U3 | Client bundle serving for a **path-named** loader entry (dev-from-repo, §4.2) | **UNVERIFIED** — gaia-cortex is host-only; if serving fails, use install_bundle. |
| U4 | Whether V3→V4 converted sessions retain `assistant/message` usage | **UNVERIFIED**; expect all-time totals to undercount pre-upgrade sessions. |
| U5 | Whale-pet actually enabled in the desktop profile | Contradicts the manifest (`bundles` list lacks it) — check `plugin_manager list_bundles` before copying anything from its *runtime* behaviour. |
| U6 | `usage/credentials-absent` error surfacing as a Remote error code | The thrown `Error` arrives as a generic invocation failure; mapping to a typed `RemoteError` code is untested. |
| U7 | Balance endpoint response schema | Taken from the parent brief (verified working there); re-confirm field names (`total_balance`, `granted_balance`, `topped_up_balance`) at build time. |

## 7. Source index

| Claim | Source |
|---|---|
| Slots, panel wiring, client format | `dsh-client-ui-schedule/lib/client.js:6793-6810`; `dsh-client-ui-sidebar/README.md:38`; `dsh-client-ui-layout/lib/client.js:601-627`; `dsh-client-ui-slots/lib/index.js:163`; whale-pet `lib/client.js:2,2160-2500` |
| `dsh.client` validation | `dsh-client-modules/lib/index.js:63-73` |
| Remote call/$mount/allowlist | `dsh-api-gateway/lib/client.js:1636-1683`; whale-pet `lib/client.js:2185,2236-2240` |
| Namespaces list, forwarded events | `dsh-api-remotes/lib/client.js` (hard-coded); `docs/recon-client.md` §5.4 |
| Credentials API | `dsh-credentials/README.md` §Use; `lib/types/index.js:28-40,117`; mount `dsh-base/cordis.patch.yml:117-118`; key present in `~/.dsh/.credentials.yaml` (name only) |
| Account-vs-API-key balance | `dsh-api-account-controller/README.md` + `lib/index.js:221-226` |
| HTTP style | `dsh-web-fetch-http/lib/index.js:3,154-165` |
| Usage events + model id | `dsh-agent-loop/lib/index.js:1092-1112,1214-1225`; `dsh-session/lib/index.js:1147` |
| Usage buckets + projections | `dsh-token-meter/lib/types/usage-projection.js:16-75`; mounts `dsh-base/cordis.patch.yml:338-339`, `dsh-web-app/cordis.patch.yml:102-103` |
| `session.projections` remote | `dsh-api-session-controller/lib/typert.host.js` (`session/projections`); `lib/index.js:3149-3163` |
| Cross-session reads | `dsh-session-query/README.md` "What you can do"; mount `dsh-base/cordis.patch.yml:149-150` |
| Typert manifest/loader rules | `dsh-typert-loader/lib/index.js:7-31,77-205,300`; whale-pet `lib/typert.host.js`; schedule descriptor `dsh-schedule/lib/typert.host.js:380-400` |
| Install/reconcile | `dsh-plugin-manager/README.md:40,63,92`; `dsh-app-boot/lib/index.js:1062-1135`; `dsh-plugin-manager/lib/types/tools.js:16` |
| Module resolution | `dsh-app-boot/lib/index.js:473-476,1584`; loader `name` semantics `@cordisjs/plugin-loader` README; path-name precedent `~/.dsh/cordis.patch.yml` (gaia-cortex) |
