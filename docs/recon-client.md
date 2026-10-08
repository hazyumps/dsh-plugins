# DSH Web client plugin — API recon

Ground truth: the **installed** Electron asar at
`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`,
packages under `/dsh/node_modules/@deepseek-ai/`.
Recon date 2026-10-07. The source checkout
`/Users/patrick/repo/deepseek-harness` (2026-08-15) is older and lacks
`ui-schedule` — do not use it for these APIs.

Extraction (shell tools cannot read the asar directly):

```sh
node /tmp/asarx/x.js "/dsh/node_modules/@deepseek-ai/<pkg>" /tmp/recon/<pkg>
node /tmp/asarx/tree.js "<substring>"
```

Reference packages read:
`dsh-client-ui-schedule` (the Automation tasks page),
`dsh-client-ui-plugin-manager` (management list page),
`dsh-client-ui-model-selection` (model + effort pickers),
`dsh-client-ui-sidebar`, `dsh-client-ui-layout`, `dsh-client-ui-slots`,
`dsh-client-ui-renderer`, `dsh-client-locale`, `dsh-client-ui-theme`,
`dsh-client-ui-primitives`, `dsh-api-gateway`, `dsh-api-remotes`,
`dsh-schedule`, `dsh-typert-registry`, `dsh-typert-protocol`,
`dsh-typert-loader`, `dsh-client-modules`.

---

## 0. Blockers, up front

**B1 — No generic Host storage Remote exists.** The 29 namespaces mounted by
`dsh-api-remotes` are a fixed list (see §5.4). There is no `storage`, `kv`, or
`pluginData` namespace. A plugin cannot persist arbitrary records to the Host
without either its own namespace or the settings/Config path.

**B2 — A new Host Remote namespace needs a generated Typert face.** The
supported pipeline is: Host service method marked `@Remote` → build-time
generator emits `lib/typert.host.js` + `lib/typert.remote-client.js` → loader
registers it via `dsh-typert-loader` → `dsh-api-remotes` `$mount`s the client
contribution. `@deepseek-ai/dsh-typert-generator` is **not shipped** in the app
(it is build-time only) and the client-contribution list in `dsh-api-remotes`
is hard-coded, so a third-party bundle cannot be added to it without rebuilding
the app.

**B3 — But there is an undocumented manual path.** Both halves accept a
hand-authored contribution object:
Host `ctx.typert.register(contribution)` ("any other owner calls
`ctx.typert.register(contribution)` directly and receives the exact disposer",
`dsh-typert-registry` README), and Client `ctx.remote.$mount(contribution)`
(a public method on the `remote` service). A plugin that hand-writes both
descriptor objects can expose and call its own namespace with no code
generation. Caveats in §5.5 — treat as UNCERTAIN until proven end-to-end.

**B4 — The shipped `schedule` namespace cannot carry the requested fields.**
Its record is `{id, kind, title, prompt, time?, timeZone?, weekdays?,
afterSeconds?, everySeconds?, scheduledAt, sessionId, status, lastDelivery?}`.
There is **no** `model`, `reasoningEffort`, or `agentPreset` anywhere in
`dsh-schedule`'s remote face (grep count: 0). Kinds available:
`after | at | every | daily | weekly | cron`. So §5/§6/§7 are two separate
problems for the requested feature: the timing subset is reusable, the
model/effort/preset trio is not — it needs B3 or a separate settings document.

**B5 — Do not import Harness Client packages.** `references/practices.md` is
explicit: never `require('@deepseek-ai/dsh-client-ui-primitives')` or any other
Harness Client package from a plugin. A plain-JS plugin has no type check and a
throwing component blanks the slot entry (`slot entry crashed in '<slot>'`).
Copy the markup/CSS from `dsh-client-ui-primitives/lib/*.module.css` into the
plugin instead, keeping only `--dsw-alias-*`/`--dsw-radius-*`/`--dsw-focus-ring-*`
token references. Same for `ctx.locale` — the reference packages' strings are
inlined in their bundles, not imported from `locale/*.json`.

---

## 1. Bundle anatomy

A plugin is a Cordis Loader bundle: a package whose `package.json` declares
`dsh.bundle.patch` and, for browser UI, `dsh.client`.

```
my-plugin/
  package.json        # name, exports ./, ./client, dsh.bundle.patch, dsh.client
  cordis.patch.yml    # inserts the Loader row(s)
  index.js            # Host half (may be empty)
  client.js           # browser half (the __ModuleLoader__ factory)
  locale/en.json      # optional: meta.title / meta.description for the Plugins card
```

`package.json` (4-file decoration template, `/tmp/skills/cordis-plugin-development/templates/decoration/package.json`):

```json
{
  "name": "@local/my-decoration",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

`cordis.patch.yml`:

```yaml
- insert:
    - id: my-decoration
      name: '@local/my-decoration'
```

`index.js` (Host half; empty is legal):

```js
/** Host half of the decoration bundle; the Client module owns the rendering. */
export function apply() {}
```

`dsh.client` fields, validated by `dsh-client-modules` (`lib/index.js:63-73`):

| field | type | meaning |
|---|---|---|
| `platform` | string, **required** | must be `"web"` to load in the Web GUI |
| `immediately` | boolean, optional | load at boot rather than lazily |
| `inject` | string[], optional | activation ordering only — other packages' **names**, not service keys |
| `external` | string[], optional | non-baseline module requests the bundle may `require` |

A package declaring `dsh.client` must export `./client` or activation fails
loudly (`dsh-client-modules: <pkg> declares dsh.client but exports no "./client" bundle`).
The host serves built bundles under `/plugins`; the browser resolves React,
Cordis and static UI libs from a frozen seed table (`PLATFORM_MODULES`).

Install with `plugin_manager action: install_bundle` and the absolute package
directory. Do not hand-write the profile's `package.json` or `cordis.patch.yml`.

---

## 2. Client module format

`client.js` is a **classic script**, not an ES module. It calls
`window.__ModuleLoader__.load({ id, factory })` exactly once.

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-schedule",   // MUST equal the package name
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");
    // ... module bodies ...
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
```

- `id` equals the package name; a mismatch means the row never resolves.
- `factory(require)` is **lazy**: running the script only registers the factory.
  All module-body side effects (CSS injection included) happen at first
  materialization. Require cycles throw.
- `require` resolves platform modules (`react`, `react-dom`,
  `react/jsx-runtime`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, …)
  then boot-graph rows. Anything else must be listed in `dsh.client.external`.
- The returned object is the plugin body: `{ inject, apply }`. `apply` may be a
  plain function or a generator (the plugin-manager uses
  `ctx.slots.inject("main", function* () { ... yield ... })`).
- **`inject` is a flat array of service keys.** The Cordis plugin stays
  inactive until all of them exist, then `apply(ctx)` runs. Declaring a service
  the profile lacks disables the plugin rather than throwing.
- Everything in `apply` must be registered through `ctx.effect(...)` /
  `ctx.on(...)` and return its cleanup. `ctx.slots.inject` and
  `ctx.locale.register` both return disposers.

Real `inject` lists, from the shipped packages — schedule:

```js
// dsh-client-ui-schedule/lib/client.js
const inject = [
  "slots", "locale", "remote", "remote.schedule",
  "conversation", "uiConversation", "uiWorkspace",
  "sessions", "workspaces", "sidebarRightTabs", "sidebarRight",
];
```

plugin-manager:

```js
// dsh-client-ui-plugin-manager/lib/client.js
const inject = [
  "slots", "locale", "remote", "remote.pluginManager",
  "remote.pluginInventory", "remote.pluginRegistryProbe",
  "configForms", "layout",
];
```

Note `remote.<namespace>` is itself an injectable service key. Injecting it is
how a client declares the namespace it needs (§5.3).

---

## 3. Slots

### 3.1 API

```js
ctx.slots.inject(ownerKey, callback)   // -> disposer
ctx.slots.register(options, Component) // -> disposer
```

`slots.inject(key, callback)`: waits for `key` to be **declared** by a parent
entry, then runs `callback` inside an effect. The callback returns one disposer
or an iterable of disposers. On undeclaration (parent unload/reload) the
callback's registrations are disposed and reinstalled when the declaration
returns. It is declaration-aware, so a plugin may activate before or after the
owner. Registering into an undeclared slot throws
``slot "<name>" is not declared (a parent entry's children table must declare it)``.

`slots.register(options, Component)`: `options.name` must be the slot key; the
slot's declared kind dictates the rest (`dsh-client-ui-slots/lib/index.js:163`):

| kind | required option | also read |
|---|---|---|
| `single` | — | `priority` (one occupant per priority) |
| `keyed` | **`key`** | `priority` |
| `list` | **`id`** | `order`, `label`, `priority` |
| `chain` | **`select`** | `priority` |

All kinds additionally accept: `inject`, `children`, `store`, `locale`,
`registrant`, `priority`.

- `label`: a string, or a function returning a string
  (`resolveSlotLabel` = `typeof label === "function" ? label() : label`). Used
  for visible text, the accessible name, and the collapsed tooltip.
- `locale`: the dictionary namespace the component's props are translated
  under. Schedule uses `MANAGER_NS = "schedule.manager"` for the page.
- `inject`: a function returning extra props, merged into the component's props.
  Called as `inject(bindingKey, actions)`; **root-scoped slots get no
  args**, session-scoped slots get the session id (e.g.
  `inject: (sessionId) => ({...})` for `conversation.session.header.utilities`).
  Return `{ hooks: { name: observableSource } }` to have the renderer bind a
  React hook prop (`useName`) for you. `{ keyedHooks: {...} }` likewise.
- `children`: a `{ childSlotKey: { kind, scope } }` table — declaring child
  slots your component renders. A child key may be declared only once.
- `order`: list slots sort by `(priority, order)`, ascending.

### 3.2 The two slot ids that matter

The sidebar entry and the main panel are **two registrations linked by a shared
string id**. From `dsh-client-ui-schedule/lib/client.js:6793-6810`:

```js
const PANEL_ID = "schedules";

// the page (keyed slot -> options.key)
ctx.slots.inject("main", () => ctx.slots.register({
  name: "main",
  key: PANEL_ID,
  locale: MANAGER_NS,
  inject: () => ({ /* props */ }),
}, TaskManagerPage));

// the sidebar entry (list slot -> options.id)
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
  name: "sidebar.panellist",
  id: PANEL_ID,
  order: 10,
  locale: MANAGER_NS,
  label: () => t("panel"),
}, TaskManagerIcon));
```

Both slots are declared by the host:

- `main` — declared **keyed, root scope** by `dsh-client-ui-layout`
  (`lib/client.js:609`), inside the `root` registration's `children` table
  alongside `sidebar` (single), `rightbar` (single), `shell.overlay` (list),
  `shell.leading` (single).
- `sidebar.panellist` — declared **list, root scope** by `dsh-client-ui-sidebar`
  (`lib/client.js:503`).

**The contract** (`dsh-client-ui-sidebar/README.md:38`): "The same id addresses
the component registered in the layout's root-scoped `main` keyed slot;
selecting a missing main entry throws without changing the current selection."
The sidebar shell owns the click — `ui-sidebar`'s own `selectPanel(id)` prop
calls `ctx.layout.selectPanel(id)` (`lib/client.js:471-476`). **The plugin
registers no click handler.** Matching `id`/`key` is the whole wiring.

You can also open the panel programmatically:

```js
ctx.layout.selectPanel(PANEL_ID);   // throws if no "main" entry carries that key
```

`ctx.layout.panelInfo` is an observable store (`getSnapshot()` /
`subscribe()`); `activePanelId` is the current key, `null` meaning the
Conversation. `main` renders `entryKey: activePanelId ?? "conversation"`.

### 3.3 Other slot ids worth knowing

From the ui-schedule and ui-plugin-manager bundles (all verified present in the
installed app, not invented):

| slot id | kind | where it renders |
|---|---|---|
| `main` | keyed | the central panel |
| `sidebar.panellist` | list | sidebar global-panel entries |
| `shell.overlay` | list | app-wide overlay (toasts survive the panel that raised them) |
| `conversation.session.header.utilities` | list | Session header, right-aligned, `order: -5` = leftmost |
| `conversation.chat.turnTail` | list | end of a turn, outside the collapsible tool group |
| `sidebar.session.row.leading` | list | leading mark on a Session row |
| `sidebar.session.row.hover` | list | inside a Session row's hover card |
| `sidebar.right.pane.tab` | keyed | right Sidebar page body |
| `sidebar.right.pane.tab.title` | keyed | right Sidebar page chip |

The right Sidebar also needs a page-type definition registered first, via
`ctx.effect(() => ctx.sidebarRightTabs.register(scheduleTaskDefinition(t)), ...)`
with `SCHEDULE_TASK_ID = "@deepseek-ai/dsh-client-ui-schedule/task"` and
`SCHEDULE_TASK_KIND = "scheduleTask"`; then `ctx.sidebarRight.openTab(KIND, { params })`.
Out of scope for the requested feature (a global page, not a tab).

`ui-plugin-manager` is the reference for a **management list page**; it uses the
same `main` + `sidebar.panellist` pair with `id: "plugins"`, `order: 0`, and
declares its own child slots (`plugins.item`, `plugins.detail.section`, …) for
sub-contributions. It also uses `store` and a generator `inject` to yield a
navigation store.

---

## 4. Minimal copy-pasteable client.js

Renders a page reachable from a new sidebar entry. Plain JS, no build step, no
Harness package imports, theme-token styling only, locale-backed label.

```js
window.__ModuleLoader__.load({
  id: "@local/my-tasks",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const NS = "myTasks";
    const PANEL_ID = "my-tasks";      // MUST match between the two slots

    const en = {
      "panel": "My tasks",
      "page.title": "My tasks",
      "page.empty": "No tasks yet.",
      "page.new": "New task",
      "page.save": "Save",
      "page.cancel": "Cancel",
    };

    // --- page component -----------------------------------------------------
    const PAGE_CSS = `
      .myt-page {
        height: 100%; min-height: 0; overflow: auto;
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
        font-size: 14px; line-height: 1.6;
        padding: 28px clamp(24px, 4vw, 48px) 48px;
      }
      .myt-head {
        display: flex; align-items: center; justify-content: space-between;
        gap: 16px; margin-bottom: 24px;
      }
      .myt-head h1 { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; }
      .myt-btn {
        height: 32px; padding: 0 14px; border: none; cursor: pointer;
        border-radius: var(--dsw-radius-md);
        font-size: 13px; line-height: 20px;
        color: var(--dsw-alias-label-primary-foreground);
        background: var(--dsw-alias-button-primary-fill);
      }
      .myt-btn:hover { background: var(--dsw-alias-button-primary-hover); }
      .myt-btn[data-variant="outline"] {
        background: transparent; color: var(--dsw-alias-label-primary);
        border: 0.5px solid var(--dsw-alias-border-l3);
      }
      .myt-btn[data-variant="outline"]:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .myt-btn:focus-visible {
        outline: var(--dsw-focus-ring-width) solid
          var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 2px;
      }
      .myt-empty { color: var(--dsw-alias-label-tertiary); padding: 48px 0; text-align: center; }
      .myt-row {
        display: flex; align-items: center; gap: 12px; padding: 8px;
        border-radius: var(--dsw-radius-md);
      }
      .myt-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .myt-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
      .myt-field + .myt-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
      .myt-label { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
      .myt-input {
        height: 32px; padding: 0 8px; box-sizing: border-box;
        border: 0.5px solid var(--dsw-alias-border-l4);
        border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 14px; outline: none;
      }
      .myt-input:focus { border-color: var(--dsw-alias-state-business-primary); }
      .myt-input::placeholder { color: var(--dsw-alias-label-dimmed); }
      .myt-textarea {
        min-height: 112px; padding: 12px; box-sizing: border-box; resize: none;
        border: 0.5px solid var(--dsw-alias-border-l3);
        border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
        font: inherit; font-size: 14px; line-height: 24px; outline: none;
      }
      .myt-textarea:focus { border-color: var(--dsw-alias-state-business-primary); }
    `;

    function TaskPage(props) {
      const t = props.t;
      // props.hooks.* would be React hooks if the registration returned { hooks }.
      const [draft, setDraft] = React.useState(null);

      return h("div", { className: "myt-page" },
        h("style", null, PAGE_CSS),
        h("div", { className: "myt-head" },
          h("h1", null, t("page.title")),
          h("button", {
            type: "button", className: "myt-btn",
            onClick: () => setDraft({ name: "", prompt: "", enabled: true }),
          }, t("page.new")),
        ),
        draft === null
          ? h("p", { className: "myt-empty" }, t("page.empty"))
          : h("form", {
              onSubmit: (e) => { e.preventDefault(); /* call ctx.remote.<ns>.save(...) */ },
            },
              h("div", { className: "myt-field" },
                h("label", { className: "myt-label" }, "Name"),
                h("input", {
                  className: "myt-input", value: draft.name,
                  onChange: (e) => setDraft({ ...draft, name: e.target.value }),
                }),
              ),
              h("div", { className: "myt-field" },
                h("label", { className: "myt-label" }, "Prompt"),
                h("textarea", {
                  className: "myt-textarea", value: draft.prompt,
                  onChange: (e) => setDraft({ ...draft, prompt: e.target.value }),
                }),
              ),
              h("div", { className: "myt-head" },
                h("button", {
                  type: "button", className: "myt-btn", "data-variant": "outline",
                  onClick: () => setDraft(null),
                }, t("page.cancel")),
                h("button", { type: "submit", className: "myt-btn" }, t("page.save")),
              ),
            ),
      );
    }

    // --- sidebar icon -------------------------------------------------------
    function TasksIcon() {
      return h("svg", {
        viewBox: "0 0 24 24", width: 16, height: 16,
        fill: "none", stroke: "currentColor", strokeWidth: 1.5,
        "aria-hidden": true, style: { display: "block" },
      },
        h("circle", { cx: 12, cy: 12, r: 8 }),
        h("path", { d: "M12 8v4l3 2" }),
      );
    }

    // --- plugin body --------------------------------------------------------
    return {
      inject: ["slots", "locale"],   // add "remote", "remote.myTasks" when wired
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { en }),
          "my-tasks: dictionaries",
        );
        const t = ctx.locale.bind(NS);

        ctx.slots.inject("main", () => ctx.slots.register({
          name: "main",
          key: PANEL_ID,
          locale: NS,
          inject: () => ({ t }),
        }, TaskPage));

        ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: () => t("panel"),
        }, TasksIcon));
      },
    };
  },
});
```

Notes that are easy to get wrong:

- `main` takes `key`; `sidebar.panellist` takes `id`. Swapping them throws at
  registration.
- Register the icon component into `sidebar.panellist`, **not** a row or a
  button. The host renders the row, the label, the selected state (via its
  `usePanelInfo`) and the click.
- `inject` on the `main` entry returns a **flat object of props**. `{ hooks }`
  and `{ keyedHooks }` are special-cased and become hook props.
- Component style: use a `<style>` element rendered inside the component so
  unmounting removes it, or register/clean it in `apply` via `ctx.effect`.
- Do not touch `document.body`, do not replace the app root.

---

## 5. Reaching a Host Remote namespace

### 5.1 The call shape

`ctx.remote.<namespace>.<method>(...args)` returns a promise of
`RemoteResult<T>`:

```ts
{ ok: true,  value: T }
{ ok: false, error: RemoteError }   // live instance; error.code is the discriminator
```

Every unary call **resolves** — it never rejects for a carrier problem (offline
folds into the error branch, an aborted signal answers `gateway/cancelled`).
Only an assembly fault rejects: wrong arity, an unmounted method, a withdrawn
contribution, a missing Context adapter. So:

```js
const result = await ctx.remote.myTasks.list();
if (result.ok) { /* result.value */ } else { /* result.error.code, result.error.message */ }
```

Never use `instanceof` to discriminate — match on `error.code`, or use
`isRemoteFailure(value)`.

Forwarded Host events: `ctx.remote.$on("<event>", listener)` — `$on`'s legal key
set is exactly the Host assembly's forwarding allowlist
(`dsh-api-remotes`'s `API_REMOTE_FORWARDED_EVENTS`). `ctx.on("connection/reset", fn)`
is the reconnect hook ordinary consumers use.

### 5.2 A real example, copied from ui-schedule

`dsh-client-ui-schedule/lib/client.js:6714-6761`, `6804`:

```js
const manager = createCatalogSource({
  list: () => ctx.remote.schedule.catalog(),
  remove: async (id) => {
    const record = manager.hooks.catalog.getSnapshot().records.find((item) => item.id === id);
    if (record === void 0) return {
      ok: true,
      value: { id, deleted: false, code: "schedule_not_found" },
    };
    return ctx.remote.schedule.delete({ sessionId: record.sessionId, id });
  },
  subscribeChanged: (listener) => ctx.remote.$on("schedule/changed", listener),
  subscribeReset: (listener) => ctx.on("connection/reset", listener),
});

const updateTask = async (request) => {
  const result = await ctx.remote.schedule.update(request);
  if (result.ok && ("record" in result.value
      || result.value.code === "schedule_conflict"
      || result.value.code === "schedule_ended"
      || result.value.code === "schedule_not_found"))
    await manager.onRetry(manager.hooks.catalog.getSnapshot().readRequest);
  return result;
};

const loadHistory = (request) => ctx.remote.schedule.history(request);
```

and the matching `inject`:

```js
const inject = ["slots", "locale", "remote", "remote.schedule", /* ... */];
```

This is the whole pattern: declare `"remote"` plus `"remote.<ns>"`, call
methods, treat the result as a tagged union, subscribe to the namespace's
change event, and re-read after `connection/reset`.

`dsh-client-ui-plugin-manager` adds an install-progress example
(`ctx.remote.$on("plugin-manager/install-log", ...)`,
`"plugin-manager/install-state"`, `"plugin-manager/changed"`).

### 5.3 How the declaration works

`inject: ["remote", "remote.schedule"]` is a Cordis service-key dependency.
`remote` is the `ClientRemote` service (`dsh-api-gateway/client`, ctx key
`remote`); each namespace is a traced child service at key
`remote.<namespace>`. The plugin stays inactive until the namespace is mounted,
so a plugin whose namespace is absent from the composition simply never
activates — that is the intended graceful-degradation mechanism.

### 5.4 Which namespaces exist

`dsh-api-remotes` mounts exactly these (namespace → methods), read from the
generated contributions in its client bundle:

```
account            ackBonusNotified, cancelSignIn, getBalance, getProfile,
                   getState, getUnnotifiedBonuses, hasRunningAccountTasks,
                   signOut, startSignIn, watch, watchExpiry
agentPresets       list, read, select
commands           execute, list
credentials        describe, set, unset
directoryPicker    createDirectory, list, pick
dynamicCordisRunner getClientCode, inventory, invoke, reportClientGuardFailure,
                   reportRenderFailure, resolveInspectQuery, resolveRequestRun,
                   runHostHalf, settleUserRun, stopFromPanel, syncInspectManifest,
                   undefineFromPanel
fileReferences     list
fileUploads        upload
goals              clear, complete, create, edit, get, pause, resume
job                follow, kill, list
llm                discoverModels, listConfigurableProviders, listProviders
messageFeedback    delete, list, put
officeToPdf        generation, render
permissionPresets  catalog
pluginInventory    list
pluginManager      cancelInstall, inspect, installBundle, listBundles,
                   listPlugins, listVersionExemptions, registries, removeBundle,
                   setBundleEnabled, setPluginEnabled, setVersionExemption,
                   waitForInstall
pluginRegistryProbe fastest
productAnalytics   enabled, report, watchPolicy
schedule           catalog, delete, history, list, update
session            attachment, cancel, canOpenWorkspacePath, control, create,
                   follow, fork, initializeDefaultModel, list, modelCatalog,
                   openWorkspacePath, page, projections, prompt, rename, search,
                   selectModel, updateQueue, workspacePathApplications
sessionFeedback    record
sessionReferenceResolver candidates
settings           describe, mutate, openSettingsDocument, replace, update
skills             list
subagents          interruptByParent, prompt
terminal           close, create, environment, follow, list, rename, resize,
                   retain, shells, write
userQuestions      answer, attachWait
workspace          archiveSession, create, delete, follow, initializeDefault,
                   insertBefore, insertSessionBefore, pinSession, rename,
                   unarchiveSession, unpinSession
workspaceFiles     changes, list, read, readBytes, stat
```

For the requested feature the two candidates that exist today are:

- **`settings`** (`describe`, `mutate`, `replace`, `update`, …) — the persistence
  path used by `ctx.configForms`. Structured, schema-validated, revisioned, but
  keyed per Host plugin entry and shaped by that entry's `Config` schema.
- **`schedule`** — the timing subset only (B4).

### 5.5 Adding a new namespace (see blockers B2/B3)

The **supported** path, end to end:

1. Host half: a service method marked `@Remote` (or a plain method bound with
   `bindTypertRemote(service, serviceKey, options)` from
   `@deepseek-ai/dsh-typert-protocol`).
2. Build: `@deepseek-ai/dsh-typert-generator` emits the host reflection +
   `lib/typert.remote-client.js`.
3. Host loader: `dsh-typert-loader` discovers the mounted package's `./typert`
   export and registers it — "Packages without the export are skipped
   silently"; "adding a `./typert` export requires a restart".
4. Host dispatch: `ctx.typertGateway.invoke()` resolves the descriptor and the
   Cordis Service at call time, validates exact named arguments, and invokes the
   public business method.
5. Client: something calls `ctx.remote.$mount(contribution)` for the generated
   client contribution. **Only `dsh-api-remotes`'s hard-coded list does this.**

The **unsupported/manual** path, which the installed code appears to permit:

```js
// Host half (index.js)
export function apply(ctx) {
  ctx.effect(() => ctx.typert.register({
    package: "@local/my-tasks",
    descriptors: [ /* hand-authored InvocationDescriptors */ ],
  }), "my-tasks: typert");
}
```

```js
// Client half (client.js), inside apply(ctx)
await ctx.remote.$mount({
  package: "@local/my-tasks",
  descriptors: [ /* the same descriptors */ ],
});
```

`ctx.typert.register(contribution)` is documented as available to "any other
owner". `ctx.remote.$mount(contribution)` is a public method on the `remote`
service (`dsh-api-gateway/lib/client.js:1636`) that validates the contribution
and installs the methods for the calling fiber.

Constraints that make this fragile (all **UNCERTAIN**, none proven end-to-end
here):

- Every Client-supplied field needs a **strict codec**: `requireStrictInputs`
  walks `descriptor.parameters[]` and throws
  `client api: generated Remote <ns>/<method> field "<name>" has no strict codec`
  unless `codec.mode === "strict"` (`dsh-api-gateway/lib/client.js`, near
  `requireStrictInputs`). The client never *executes* those schemas, but the
  field must be present and well-formed.
- Descriptor ids must be unique and namespace-collision-free; duplicate
  endpoints are rejected.
- Method names must not collide with the generated namespace service's own
  members.
- Whether the Host gateway accepts a descriptor whose `create()` returns a
  non-zod stub is **untested**. The straight answer is that the plugin should
  depend on `zod` (it is bundled into several shipped client bundles, e.g.
  `dsh-api-remotes` inlines zod 4.4.3) and author real schemas.
- `dynamicCordisRunner.runHostHalf` / `invoke` is the *other* runtime Host-code
  path (the `cordis` tool / Plugin Manager creator workflow). Its own README
  says "Definitions disappear on restart" and "no model tool creates dynamic
  definitions" — it is not a persistence story. Whether it can define a Remote
  namespace is **UNCERTAIN**.

**Recommendation for the parent agent:** before committing to a bespoke
namespace, decide between (a) proving the manual `ctx.typert.register` +
`ctx.remote.$mount` pair with a throwaway two-method namespace, or (b) storing
the task list as the plugin's own `Config` document and editing it through
`ctx.configForms.get(entryId)` over `remote.settings`. Path (b) is shipped,
supported and revisioned but stores one document per Host plugin entry, so a
list of tasks lives inside that document. Path (a) is the only way to get a
proper CRUD namespace, and its cost is unknown until the spike runs.

---

## 6. Model catalog and reasoning effort

Source: `dsh-client-ui-model-selection`. The client injects
`["commandUi", "locale", "sessions", "slots", "remote", "remote.session"]` and
loads one shared catalog per Host generation.

Call, verbatim (`dsh-client-ui-model-selection/lib/client.js:118`):

```js
const operation = this.ctx.remote.session.modelCatalog().then((response) => {
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  for (const group of response.value.groups)
    for (const model of group.models)
      this.reasoning.set(JSON.stringify([group.id, model.id]), model.reasoning);
  this.store.set({ value: response.value, status: "ready", error: null });
  return response.value;
});
```

Value shape, from the Host builder
(`dsh-api-session-controller/lib/types/catalog.js`, `buildModelCatalog`):

```ts
{
  default: { provider, model, reasoningEffort? },   // deployment default
  routableProviders: string[],                      // group ids
  groups: [{
    id, name,                                      // provider id and display name
    models: [{
      id, name,
      description?,
      reasoning?: {
        efforts: [{ id, name, description? }],     // the thinking-level choices
        defaultEffort?,                            // omit => "provider default" entry
      },
    }],
  }],
  failures: [{ id, name, message }],               // providers that failed to enumerate
}
```

Picker semantics, from the same bundle (`lib/client.js:540-573`):

- A **selection** is `{ provider: group.id, model: model.id, reasoningEffort? }`.
  When `model.reasoning.defaultEffort` is defined it seeds
  `reasoningEffort`; otherwise the field is omitted entirely.
- `reasoning === undefined` means the model exposes **no** effort control — the
  picker renders only the model, and the retained effort is shown as-is.
- `efforts` is the full choice list; each entry renders `effort.name`, submits
  `effort.id`.
- When `defaultEffort` is **absent**, an extra "provider default" choice is
  prepended with `effort: undefined` and the localized
  `t("effort.providerDefault")` label.
- Effective effort = `selection.reasoningEffort ?? reasoning.defaultEffort`.

So a plugin implementing the requested "thinking level" field needs exactly two
things from the catalog per model: `reasoning.efforts[]` and
`reasoning.defaultEffort`. Also inject `remote.session` (and `sessions` if it
must act on a real session). Note `modelCatalog()` requires no session id —
it is a global read; per-session selection writes go through `session.selectModel`
and `session.initializeDefaultModel`, which are outside this feature's scope.

Other model-adjacent namespaces: `llm` (`listProviders`,
`listConfigurableProviders`, `discoverModels`) exists but is the Host registry
face, not the picker face. Prefer `session.modelCatalog`.

---

## 7. Agent preset picker

`dsh-client-ui-agent-preset` injects
`["slots", "sessions", "locale", "remote", "remote.agentPresets", "remote.settings", "configForms"]`
and uses the `agentPresets` namespace (`dsh-agent-preset-registry`):

- `agentPresets.list()` → `AgentPresetRoster` (= `{ presets: [...] }`); the
  client tolerates the roster being unavailable by mapping
  `gateway/invocation-unavailable` to an **empty roster** rather than an error:

  ```js
  const result = await ctx.remote.agentPresets.list();
  if (result.ok) return { ok: true, value: result.value };
  if (result.error.code === "gateway/invocation-unavailable")
    return { ok: true, value: EMPTY_ROSTER };
  return { ok: false, error: result.error.message };
  ```

- `agentPresets.read(agentPreset)` → document
- `agentPresets.select(...)` → apply a preset

Its inject list is the pattern to copy for a preset selector that also edits
settings: `remote.agentPresets` + `remote.settings` + `configForms`.

---

## 8. Locale

Registration (`dsh-client-ui-schedule/lib/client.js:6705-6713`):

```js
ctx.effect(() => ctx.locale.register(NS, { zh: zh$1, en: en$1 }),
  "ui-schedule: dictionaries");
const t = ctx.locale.bind(MANAGER_NS);
```

API (`dsh-client-locale/lib/client.js:1387-1428`):

| call | behaviour |
|---|---|
| `ctx.locale.register(ns, { en: dict, zh: dict })` | registers several locales at once; returns a disposer |
| `ctx.locale.register(ns, "en", dict)` | single-locale form |
| `ctx.locale.bind(ns)` | returns a memoized `t(key, params?)`; `{name}` is interpolated from `params` |
| `ctx.locale.resolveText(text)` | resolve a string-or-function locale value (used by plugin-manager) |
| `ctx.locale.subscribe(fn)` | fires when the active locale changes |

Constraints:

- Locale ids must match the BCP 47-style pattern or `register` throws
  ``locale id "<x>" is not a BCP 47-style tag"``.
- Re-registering the **same `ns` + locale** throws
  ``locale namespace "<ns>" already has locale "<en>"`` — register once per `ns`
  and guard with `ctx.effect`.
- Missing keys fall back through the locale chain, then to `ns = "common"`, then
  to the key itself, so a missing key renders the key rather than throwing.
- The `locale` option on a slot registration is what gives the component its
  namespace; keys are looked up there.
- `locale/en.json` + `locale/zh.json` in the package are **not** the component
  strings — they carry `meta.title` / `meta.description` for the Plugins page
  card. Example (`dsh-client-ui-schedule/locale/en.json`):

  ```json
  {
    "meta": {
      "title": "Task interface",
      "description": "The Automation tasks page in the sidebar, plus task cards and reminder marks in sessions."
    }
  }
  ```

  Component dictionaries are inlined in the bundle (see `const en$1 = {...}` at
  `lib/client.js:6355`).

---

## 9. Theme tokens

Authoritative definitions: `dsh-client-ui-theme/lib/client.js`, variables
`base_css_default` (`:root`, radius/font/easing) and
`design_platform_css_default` (`body` and `body[data-ds-dark-theme]`, the alias
palette). 102 `--dsw-alias-*` tokens plus 6 static palettes. Dark mode is the
`body[data-ds-dark-theme]` selector, which the theme bootstrap sets before first
paint — **a plugin never needs to branch on theme**; read the token only.

Component → token mapping, read from the shipped CSS:

| purpose | tokens | host component / file that uses them |
|---|---|---|
| page surface | `--dsw-alias-bg-base` | `TaskManagerPage.module.css` `.page` (`background: var(--dsw-alias-bg-base)`); also `body { background-color: var(--dsw-alias-bg-base) }` |
| raised surfaces / layers | `--dsw-alias-bg-layer-1`, `-2`, `-3` | `Input.module.css` `.wrap` (layer-1), `Pill.module.css` `.pill` (layer-2), `Tag` solid text (layer-3) |
| menu / popover surface | `--dsw-specific-menu`, `--dsw-menu-backdrop-filter`, `--dsw-menu-surface-fill` | `MenuSurface.module.css` `.material`; ui-schedule popover `.panel` |
| menu elevation | `--dsw-elevation-prominent` (with `--dsw-elevation-stroke-color: var(--dsw-alias-border-l1)`) | ui-schedule popover, `Menu.module.css`, `Modal.module.css` |
| hairline borders | `--dsw-alias-border-l1` (faintest) → `-l2` → `-l3` → `-l4` (strongest) | `Button.module.css` `.outline` (l3), `Input.module.css` `.wrap` (l4), `fields.module.css` `.field + .field` (l2), ui-schedule `.ruleRows` (l3), `.detail` border-left (l4) |
| text | `--dsw-alias-label-primary`, `-secondary`, `-tertiary`, `-caption`, `-dimmed`, `-primary-foreground` | `Button.module.css` (`primary`, `-foreground`), `fields.module.css` `.label`/`.help`, `Input.module.css` `::placeholder` (`-dimmed`), `Pill.module.css` (`-secondary`) |
| hover / active wash | `--dsw-alias-interactive-bg-hover`, `-active`, `-hover-solid`, `-hover-accent`, `-hover-danger` | `Button.module.css` `.ghost`, `Pill.module.css` `.interactive`, ui-schedule `.row`/`.filterTab` |
| primary button | `--dsw-alias-button-primary-fill`, `-hover`, `-dimmed` | `Button.module.css` `.primary` |
| ghost button active | `--dsw-alias-button-ghost-active-fill`, `-border`, `-hover` | `Pill.module.css` `.active` |
| elevated / floating button | `--dsw-alias-button-elevated-fill`, `--dsw-alias-button-floating-fill`, `-hover` | `Button.module.css`, toolbar/float controls |
| toolbar button | `--dsw-alias-button-tool-bar-fill`, `-hover`, `-fill-invisible` | `Button.module.css` `.toolbar` |
| link / accent | `--dsw-alias-link`, `--dsw-alias-state-business-primary`, `-tertiary` | ui-schedule `.detailTab[aria-selected=true]`, focus borders |
| toggle / switch | `--dsw-alias-border-l3` (off track), `--dsw-alias-brand-primary` (on track), `--dsw-alias-switch-thumb`, `--dsw-alias-label-primary-foreground` (thumb) | `Switch.module.css` |
| focus ring | `--dsw-focus-ring-width`, `--dsw-focus-ring-color` (fallback `--dsw-alias-state-business-primary`) | `Switch.module.css`, `Button.module.css` in ui-schedule, `fields.module.css` `.helpButton` |
| radii | `--dsw-radius-xs` 4px, `-sm` 8px, `-md` 12px, `-lg` 16px, `-xl` 20px, `-panel` 28px | `Button.module.css`, `Input.module.css`, `MenuSurface.module.css`, `Pill.module.css` |
| scrollbars | `--dsw-alias-scrollbar-bg-l1`/`-l2`, `--dsw-alias-scrollbar-hover-l1`/`-l2`, plus indirection `--dsh-scrollbar-width`, `--dsh-scrollbar-thumb`, `--dsh-scrollbar-thumb-hover`, `--dsh-scrollbar-thumb-border`, `--dsh-scrollbar-track-margin` | ui-schedule `.pageScroll`, `.detailScroll`, popover `.menu` |
| sidebar fill | `--dsw-specific-sidebar-fill` | ui-schedule `.notice`; the sidebar column |
| sidebar nav item | `--dsw-specific-sidebar-nav-item-active`, `-hover`, `-active-accent` | `ui-sidebar` panel rows |
| status colors | `--dsw-alias-state-error-primary`/`-secondary`, `-success-primary`/`-secondary`/`-tertiary`, `-warn-primary`/`-secondary`/`-tertiary`/`-label`, `-idle-primary` | ui-schedule `.deleteButton` (error), `.ruleHintError`, overdue row (warn) |
| toast | `--dsw-alias-toast-bg`, `--dsw-alias-toast-label` | `Toast.module.css` |
| tooltip | `--dsw-alias-tooltip-bg`, `--dsw-alias-tooltip-key-bg` | `Tooltip.module.css` |
| modal / mask | `--dsw-alias-bg-mask-1`/`-2`/`-3`, `--dsw-alias-bg-mask-drop` | `Modal.module.css`, `RiskConfirmation.module.css` |
| selection | `--dsw-alias-bg-multi-select` | multi-select rows |
| neutral chip | `--dsw-alias-bg-module-platform` | `Tag.module.css` `[data-tone='neutral']`, ui-schedule interval stepper |
| typography | `--dsw-font-family`, `--dsw-font-family-brand`, `--ds-font-family-code`, `--ds-ease-in-out`, `--ds-transition-duration{,-fast,-slow}` | `base_css_default` `:root`; ui-schedule `.page` font-size 14/line-height 1.6 |
| settings card | `--dsw-alias-settings-card-fill`, `--dsw-alias-settings-card-stroke` | defined in `base_css_default`'s `body` block; used by ui-settings cards |

Findings worth carrying into implementation:

- **`--dsw-alias-bg-layer-4` is referenced but never defined.** It appears in
  `dsh-client-ui-primitives/lib/settings-form/fields.module.css`
  (`.helpButton:hover`) and in no token block. That declaration resolves to
  nothing. Do not copy it; use `--dsw-alias-bg-layer-3` or
  `--dsw-alias-interactive-bg-hover`.
- The real `--dsw-alias-bg-layer-*` set is 1–3; there is no layer-4 in the
  shipped stylesheet.
- `layer-1..3` are all the **same value in light mode** and diverge in dark
  mode. Do not assume a visible step in light.
- The static palette (`--dsw-static-*`) is for artwork only; the 102 aliases are
  the theme-aware surface.
- `--dsw-alias-border-l2-darkmode-thin` exists for hairline borders that need a
  lighter stroke in dark mode.
- A page in the Conversation's place should set
  `height/min-height: 0; overflow: auto` and its own scroll gutter, the way
  `TaskManagerPage.module.css` does, or it will not scroll inside the shell.

---

## 10. Uncertainty register

| # | Item | Status |
|---|---|---|
| U1 | Hand-authored `ctx.typert.register(contribution)` + `ctx.remote.$mount(contribution)` actually working end-to-end for a third-party bundle | **UNCERTAIN** — both entry points exist and are documented/observable, but no shipped package does this outside the generated pipeline. Needs a two-method spike. |
| U2 | Whether Host-side strict validation accepts a hand-written schema (zod vs stub) | **UNCERTAIN** — the client only checks `codec.mode === "strict"` and never executes the schema; the Host path was not traced to a conclusion. |
| U3 | Whether `dynamicCordisRunner.runHostHalf` can define a Remote namespace | **UNCERTAIN** — plausible from its method list; its README frames definitions as process-local and restart-cleared, so it is not a persistence answer. |
| U4 | The exact `AgentPresetRoster` shape beyond `{ presets: [...] }` | **UNCERTAIN** — only the top-level key was confirmed. Read `dsh-agent-preset-registry/lib/types/*` for the full record. |
| U5 | Whether `cfg.configForms.get(entryId)` is usable by a plugin for its **own** entry | **LIKELY** — the README describes "Feature adapters use `ctx.configForms.get(entryId)`"; `entryId` is the Host plugin entry id. Not exercised here. |
| U6 | Whether `session.modelCatalog()` is callable with a plugin-injected `remote.session` but no `sessions` service | **UNCERTAIN** — ui-model-selection injects both; the call itself needs no session id, but the plugin likely must still inject `sessions` for the composition to consider it active. |
| U7 | Full `main` slot props contract (what the framework hands a main-panel component besides injected props) | **UNCERTAIN** — `renderSlot("main", {}, { entryKey })` passes no explicit props; the observed prop surface is the injected face plus the standard kit. |
| U8 | The full, sorted list of `sidebar.panellist` entry ids in the default profile (`plugins` order 0, `schedules` order 10) | **PARTIAL** — only those two shipped registrations were found. Other compositions may add more. |
| U9 | The `--dsw-alias-*` inventory as *inspected at runtime* | The list here is read from the shipped stylesheet, which is the definitional source; the runtime `Theme` inspector may report a superset if a third-party theme adds aliases. |
| U10 | `--dsw-alias-bg-layer-4` | Confirmed **undefined** in the shipped stylesheet while referenced by shipped primitives CSS. Report as a host defect, not a token to use. |

---

## Appendix — files that settle each question

| Question | File |
|---|---|
| Client module format, `inject`/`apply` | `dsh-client-ui-schedule/lib/client.js:1-12`, `:6680-6866` |
| Slot ids + registration options | `dsh-client-ui-schedule/lib/client.js:6740-6861`; `dsh-client-ui-plugin-manager/lib/client.js:3712-3775` |
| `main` slot declaration (keyed/root) | `dsh-client-ui-layout/lib/client.js:601-627` |
| `sidebar.panellist` declaration (list/root) | `dsh-client-ui-sidebar/lib/client.js:503` |
| id ↔ key contract + click wiring | `dsh-client-ui-sidebar/README.md:38`; `dsh-client-ui-sidebar/lib/client.js:454-476` |
| `ctx.layout.selectPanel` | `dsh-client-ui-layout/lib/client.js:449-470` |
| Slot kind → required option, sort order | `dsh-client-ui-slots/lib/index.js:163-215` |
| `slots.inject` semantics | `dsh-client-ui-renderer/lib/client.js:1343-1402` |
| `inject` args + `hooks` binding | `dsh-client-ui-renderer/lib/client.js:414-435` |
| Remote call + `RemoteResult` | `dsh-api-gateway/README.md` (Client service section) |
| `$mount` | `dsh-api-gateway/lib/client.js:1636-1683` |
| `requireStrictInputs` | `dsh-api-gateway/lib/client.js` (near `requireStrictInputs`) |
| Mounted namespace list | `dsh-api-remotes/lib/client.js` (`namespace: "..."` occurrences) |
| `ctx.typert.register` | `dsh-typert-registry/README.md`; `lib/index.js:398-419` |
| `bindTypertRemote` / `Remote` | `dsh-typert-protocol/lib/index.js` (export list) |
| Model catalog shape + picker rules | `dsh-api-session-controller/lib/types/catalog.js:10-60`; `dsh-client-ui-model-selection/lib/client.js:118-121`, `:540-573` |
| Agent preset remote | `dsh-client-ui-agent-preset/lib/client.js:1082-1099`, `:1527-1535` |
| Locale API | `dsh-client-locale/lib/client.js:1387-1434` |
| Theme tokens | `dsh-client-ui-theme/lib/client.js` (`base_css_default`, `design_platform_css_default`) |
| Component CSS | `dsh-client-ui-primitives/lib/*.module.css`, `lib/settings-form/fields.module.css` |
| `dsh.client` manifest validation | `dsh-client-modules/lib/index.js:63-73`, `:713-726` |
| Plugin bundle template | `dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/*` |
| UI plugin rules | `dsh-agent-preset/skills/cordis-plugin-development/references/{ui-plugin,practices,host-plugin,user-actions}.md` |
