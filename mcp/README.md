# dsh-plugin-mcp

Every MCP server this Harness is composed with, as a sidebar panel: **MCP**.

```
[🔍] Search      [active]        [◈] Unraid      [active]
     Web search and page reading      The NAS: array, containers, VMs
     search · HTTP                    unraid · HTTP
     http://192.0.2.11:8027/mcp       http://192.0.2.10:8043/mcp
     5 tools · 180s timeout           126 tools · 120s timeout
```

Read-only. It answers "what is this Harness actually connected to, and is it
alive" without opening Settings, scrolling the plugin inventory, or reading
`~/.dsh/cordis.patch.yml`.

## Install

In the DSH Web sidebar: **Plugins → Add plugin**, give it this folder's
absolute path, then **Install** and **Enable now**.

```
/Users/you/repo/dsh-plugins/mcp
```

A local path installs as a link, so edits are picked up on the next Host
restart. The sidebar entry lands between **Scheduled tasks** and **Usage**.

## Where the numbers come from

| Shown | Source |
|---|---|
| the server list | `ctx.loader.entries()` filtered to `@deepseek-ai/dsh-mcp-client` rows |
| server name, transport, endpoint, timeout | the row's own `config`, read raw off the entry |
| `active` / `failed` / `pending` | the row's root **fiber** state, mapped the way `dsh-host-plugin-inventory` maps it |
| `auth` | whether the row config carries `headers` or `env` — **never the value** |
| `126 tools` | `ctx.tools.schemas()` with no scope: the global registry view the model itself is dispatched through |
| the whole list again every 20 s | the browser half's own poll, plus the **Refresh** button |

A profile without the tool registry (or one whose `schemas()` throws) shows
`tool count unavailable` rather than a wrong `0`. A server that discovered
zero tools genuinely reads `0 tools`.

### Why the endpoint is the only string from the config

The row shape in `lib/schema.js` is validated **strictly** — an unknown field is
an error, not something stripped — and it has no field a header or env value
could travel in. `lib/servers.js` reads `url` / `command` / `args` for display
and nothing else, so the `affine` bearer token in the home patch cannot reach
the browser. `tests/servers.test.js` asserts that against a payload containing
the real token's shape.

### Why the panel is read-only

The rows are inserted by gaia's **home** patch, one layer *above* the profile
patch that the Plugins page's switches write to. A `disabled` override written
at the profile layer is applied before the row exists, so the loader logs
`patch: entry gaia-mcp-<name> not found` and skips it — the switch would appear
to work and change nothing. Toggling needs either a gaia-side toggle rendered
inside the home patch, or a plugin-owned override block *after* the
`# <<< gaia sync-dsh` marker. That is the next pass, not this one.

## Icons

`client.js` carries one mark per server name — label, accent hue, traced glyph,
and a one-line note — chosen to read at 20px on the dark theme:

| Server | Mark | Note |
|---|---|---|
| `search` | magnifier | Web search and page reading |
| `diagram` | node graph | Render diagrams to images |
| `unraid` | stacked drives | The NAS: array, containers, VMs |
| `lab_power` | power symbol | Wake and sleep the lab hosts |
| `affine` | stacked documents | Docs, tables and kanban |
| `computer_use` | screen with a pointer | Drive macOS apps through the AX tree |
| `ms365_outlook` | envelope | Mail and calendar |
| `ms365_teams` | two figures | Chats and channels |
| `ms365_sharepoint` | share nodes | Sites, lists and files |
| `ynab` | wallet | Budgets and accounts |
| `nst` | mortarboard | Training Nexus: cohort and field readiness |

A server this file has never seen is **not** a broken card: it renders with a
neutral plug mark, its name title-cased from the namespace, and no invented
description. Adding a server to `gaia/mcp.yml` and running `gaia sync-dsh` is
enough to make it appear.

## Configuration

There is none, on purpose. The Host half reads only the Loader and the tool
registry, and exports no schemastery `Config` — a plugin installed into a
profile by path resolves no bare dependencies, so `Config` is not worth the
import (see *No bare imports*). The browser half re-reads the list every 20
seconds and on demand from **Refresh**; that interval is a constant in the
file, not a setting. Change it there if 20s is wrong.

## No bare imports

A plugin installed into a profile by path resolves **no** bare dependencies. The
`link:` install does not install the package's own `dependencies`, and the
Harness's `@deepseek-ai/*` packages are not on the plugin's resolution path, so:

- `import { z } from 'zod'` → `ERR_MODULE_NOT_FOUND`
- `import Schema from '@deepseek-ai/schemastery'` → `ERR_MODULE_NOT_FOUND`
- the Host reports the entry as `failed to import` and the plugin never activates

The Host half imports **only** `node:` builtins (none today) and relative
files, and `lib/schema.js` is a ~140-line validator because the gateway only
ever calls `codec.create().parse(value)`. The browser half `require`s `react`
and nothing else — never a `@deepseek-ai/dsh-client-*` package, which throws and
blanks the slot entry silently.

## Development

```sh
npm test          # extracts the shipped typert loader + schemastery from app.asar first
```

39 tests, in four groups:

- `tests/servers.test.js` — the read path against a fake Loader and tool
  registry, including that a credential never reaches the payload.
- `tests/schema.test.js` — the strict codec: unknown fields, absent fields,
  enums, and the integer bounds a count must satisfy.
- `tests/client.test.js` — loads `client.js` as a classic script with a
  four-hook React stub and renders the real component tree. It checks the
  sidebar/page option names (`main` takes `key`, `sidebar.panellist` takes
  `id` — swapping them throws), that the descriptors the browser mounts match
  `lib/contract.js` id for id, and that every locale key the component asks for
  exists.
- `tests/package.test.js` — the manifest points at files that exist, and the
  bundle patch names this package under an addressable id.

`tests/manifest.test.js` runs `lib/typert.host.js` through the **shipped**
`validateTypertManifest`, the same check the Host applies when the plugin row
mounts — not a reimplementation of its rules.
