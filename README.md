# dsh-plugins

DeepSeek Harness plugins, one folder per plugin. Each folder is a standalone npm
package that DSH can install on its own by absolute path — there is no root
workspace, so installing one plugin never drags in another.

```
dsh-plugins/
  README.md            this file
  docs/                what the installed Harness actually does, with citations
  mcp/                 one plugin
  scheduled-tasks/     one plugin
  usage/               one plugin
```

## Installing a plugin

In the DSH Web sidebar: **Plugins → Add plugin**, give it the absolute path to
the plugin folder, then **Install** and **Enable now**.

```
/Users/you/repo/dsh-plugins/scheduled-tasks
```

A local path installs as a link, so edits to the source are picked up on the
next Host restart. Installing and enabling a profile bundle is a
`plugin_manager` operation, which is enabled in Creator mode; from a normal
session the Plugins page is the way in.

## Adding a plugin

A plugin is a bundle plus, optionally, a browser half. Four files minimum:

| File | Purpose |
|---|---|
| `package.json` | `exports` (`.` and `./client`), `dsh.bundle.patch`, `dsh.client`, and an `icon` |
| `cordis.patch.yml` | `- insert: [{ id, name }]` — the row the bundle contributes |
| `index.js` | Host half: `export const name`, `export const inject`, `export const Config`, `export function apply(ctx, config)` |
| `client.js` | Browser half: one `window.__ModuleLoader__.load({ id: '<package name>', factory })` call |

Add `lib/typert.host.js` and an `exports["./typert"]` entry when the browser
half needs to call the Host. A sidebar entry plus a page is two slot
registrations sharing one id — `main` takes `key`, `sidebar.panellist` takes
`id`, and swapping them throws.

The DSH installation ships a `cordis-plugin-development` skill with a working
decoration template and reference notes; it is inside `app.asar`, so extract it
rather than reading it in place. [docs/recon-host.md](docs/recon-host.md) and
[docs/recon-client.md](docs/recon-client.md) cover what this repo has already
established about the installed version.

## Traps worth knowing before you write one

Each of these cost real time to find, and each fails loudly at load or silently
at runtime.

- **A plugin installed by path resolves no bare dependencies at all.** Not
  `@deepseek-ai/*` (not on npm, not in the profile's `node_modules`, no fallback
  resolver) and not a published package either — a `link:` install does not
  install the package's own `dependencies`. Observed 2026-10-07 by `usage`:
  `import { z } from 'zod'` and `import Schema from '@deepseek-ai/schemastery'`
  both threw `ERR_MODULE_NOT_FOUND` from the profile anchor, and the Host
  reported the row as `failed to import`. The Host half must import only
  `node:` builtins and relative files: hand-roll what you need (the gateway only
  ever calls `codec.create().parse(value)`, so a 60-line validator replaces zod)
  or bundle the dependency into your own file. The one working third-party
  plugin on this machine is self-contained for this reason.
- **Do not `export default apply`.** Cordis prefers `default` and then treats
  it as a service class: it calls `apply` with `new` and drops your `inject`,
  so the plugin activates before its services exist.
- **A Config schema is optional, and a `.volatile()` field is a live
  reference.** Read it with `.get()`; no shipped package chains `.default()`
  with `.volatile()`, and read as a plain value it yields `{}` — truthy, and
  quietly wrong. If you can avoid `Config` entirely, do: put settings in your
  own store and edit them in your own page.
- **Reserved Remote method names.** A namespace service owns `ctx`, `empty`,
  `invokeRemote`, `methods`, `name`, `namespace` and the prototype's own
  members, which includes **`remove`**. Mounting one throws
  `method "<ns>/remove" conflicts with its namespace service`. Use `delete`.
- **`sessionController.prompt(request, signal)` takes a signal.** A browser
  caller gets one from the gateway; from Host code you must supply it, or the
  call throws on `undefined`.
- **`sessionController.selectModel` also saves the global default model.**
  A background job that sets a model changes what the user's next session
  opens with unless it writes the previous default back.
- **`sessionController.prompt` dedupes on `requestId`,** and
  **`sessionController.create` defaults `cwd`** to the Host's process
  directory. Always pass a fresh id and an explicit `cwd`.
- **`ctx.sessionController` is mounted by the Web application,** not the base
  bundle. Declaring it in `inject` makes the plugin wait in a headless profile
  instead of failing.
- **Storage domain names must match `^[a-z][a-z0-9_]*$`** — no hyphens.
- **`ctx.jobs`, `ctx.jobController`, and the `job_*` tools are taken** by
  background shell-process jobs.
- **A client plugin must `ctx.remote.$mount(...)` its own descriptors** before
  the namespace exists, with the same ids the Host registers. The client never
  executes the codecs, but each needs `mode: 'strict'`.
- **Never require a `@deepseek-ai/dsh-client-*` package** from a client plugin.
  A throwing component blanks the slot entry silently.
- **A sidebar entry is two registrations sharing one id** — `main` takes `key`,
  `sidebar.panellist` takes `id`. Swapping them throws.
- **The patch layers apply bundle → profile → home → CLI** (`app-boot`'s
  `applyEntryPatches`, applied in that order, with inserted entries indexed as
  they are added so a later patch in the *same* list can target an earlier
  insert). Two consequences the Plugins page cannot paper over: a row a
  **bundle** patch inserts is toggleable, because the switch writes `disabled`
  into the profile patch which is applied *after* the bundle; a row the **home**
  patch inserts is not, because the profile patch is applied *before* it exists
  — the loader warns `patch: entry <id> not found` and skips it, and
  `pluginManager.listPlugins()` reports the row as `unaddressable` rather than
  offering a switch. Observed 2026-10-07 on the 11 `gaia-mcp-*` rows.
- **Do not mutate Loader entries from a plugin.** `ctx.loader.create/update/remove`
  on the root `Include` ends in `EntryTree.write()` → `Include.write()`, which
  dumps `root.data` — the *composed* tree — into the profile's `cordis.yml`.
  Persist by writing a patch file, the way `pluginManager` and
  `configEditor` do.

## Testing a plugin

`@deepseek-ai/*` packages resolve only inside the running Harness, so plain
`node --test` cannot import them. The pattern used in
[scheduled-tasks/tools/sync-test-deps.mjs](scheduled-tasks/tools/sync-test-deps.mjs)
is worth copying: extract the real shipped modules out of `app.asar` into a
gitignored `tests/.fixtures/`, then map the bare specifiers onto those copies
with a Node `--import` resolve hook. The tests then exercise the shipped code
rather than a reimplementation, and survive a Harness upgrade by re-running the
extractor.

## Verifying in the real Harness

Unit tests do not prove a plugin loads. Cordis imports and activates it, and
that is where the last two bugs in `scheduled-tasks` surfaced. You can run the
real Harness against a **throwaway home** without touching your own profile:

```
export DSH_HOME=/tmp/dsh-home
mkdir -p $DSH_HOME/profiles/test
cp <a shipped profile>/{package.json,cordis.yml,pnpm-workspace.yaml} $DSH_HOME/profiles/test/
dsh plugin --profile test add /absolute/path/to/the/plugin
dsh --profile test "hi"
```

`dsh plugin add` performs both halves of an install — the `pnpm add` and the
`dsh.profile.bundles` entry — so this reproduces the real thing. Watch the
output for the plugin's row: `failed to import` is a module-resolution problem,
`pending (waiting for service: ...)` means it loaded and is correctly gated, and
silence means it activated.

Give the test profile a real goal to prove behaviour, not just loading: seed
your plugin's store with an overdue task and check that the run happens. That is
what proves the whole pipeline rather than the import.

## Reference

- `docs/recon-host.md` — Host services: session control, storage, tools, the
  Typert Remote layer.
- `docs/recon-client.md` — client plugin format, slots, remote calls, the model
  catalog, theme tokens.
- `docs/recon-schedule.md` — the shipped scheduler's exported recurrence
  helpers.
