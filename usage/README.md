# dsh-plugin-usage

Balance, spend, and token usage for the providers this Harness routes to, as a
sidebar panel: **Usage**.

The balance is real — it comes from the provider over the same API key the model
route uses, so it works without a DeepSeek account sign-in. The spend is an
estimate priced from the Harness's own session logs, because DeepSeek exposes no
API-key usage endpoint.

```
Balance · USD          $62.46
                       $62.46 topped up · checked 16:04:12

Today                  $1.16      Last 7 days  $1.16
Last 30 days           $1.16      All time     $1.16
```

## Install

In the DSH Web sidebar: **Plugins → Add plugin**, give it this folder's absolute
path, then **Install** and **Enable now**.

```
/Users/you/repo/dsh-plugins/usage
```

A local path installs as a link, so edits are picked up on the next Host restart.

## Where the numbers come from

| Number | Source |
|---|---|
| Balance | `GET https://api.deepseek.com/user/balance`, `Authorization: Bearer <DEEPSEEK_API_KEY>` |
| Tokens | `~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd` — every `assistant/message` row carries `usage` and its `provider`/`model` |
| Cost | tokens × the official rate card, split peak/off-peak |

The key is resolved through the Host credentials service first, then the launch
environment — the same precedence the `llm-deepseek-api-key` provider uses. The
value never reaches the browser half: the Host builds the whole report.

The panel re-reads the balance when the cached read is older than
`refreshSeconds` (60 by default), and can be refreshed by hand at any time.

### Why the logs are read as files

DSH appends each session-log record as its **own zstd frame**, and Node's
`zstdDecompressSync` stops after the first frame — a whole-file call silently
returns one record instead of the whole log. `lib/zstd.js` walks the frame magic
and decodes each frame, which reproduces `zstd -dc` byte for byte. Reading files
(rather than the session services) also means the panel covers every workspace on
disk, not just sessions this Host has open.

A full pass over ~24 logs takes ~200 ms and is cached per file on
`(size, mtime)`, so a repeated summary is a stat-walk.

## Rates

| Model | Input (cache hit) | Input (cache miss) | Output |
|---|---|---|---|
| `deepseek-flash` (V4.1 Flash) | $0.003 / $0.006 | $0.15 / $0.30 | $0.60 / $1.20 |
| `deepseek-v4-pro` | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 |

Off-peak / peak, USD per 1M tokens, from
[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing), read
2026-10-07. Peak is 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday. Cache writes
are not billed. The scan keeps the peak slice of every counter, so each request
is priced at the rate that applied when it ran.

Two limits worth knowing:

- **Chinese public holidays are not modelled.** On those days real billing is
  off-peak while this estimate uses peak rates, so a holiday is over-estimated by
  at most one window's worth.
- **An unknown model is unpriced, not free.** A model with no rate card shows
  `—` instead of `$0.00`, so a new model can never silently read as free.

## Configuration

Environment variables only, with defaults. There is deliberately no schemastery
`Config` export and no Configure page — see *No bare imports* below.

| Setting | Environment | Default |
|---|---|---|
| credential ref | `DSH_USAGE_API_KEY_ENV` | `DEEPSEEK_API_KEY` |
| API origin | `DSH_USAGE_ORIGIN` | `https://api.deepseek.com` |
| sessions root | `DSH_USAGE_SESSIONS_ROOT` | `$DSH_HOME/sessions`, else `~/.dsh/sessions` |
| day-bucket zone | `DSH_USAGE_TIMEZONE` | the Host zone |
| days listed | `DSH_USAGE_HISTORY_DAYS` | `30` |
| balance cache | `DSH_USAGE_REFRESH_SECONDS` | `60` |

## No bare imports

A plugin installed into a profile by path resolves **no** bare dependencies. The
`link:` install does not install the package's own `dependencies`, and the
Harness's `@deepseek-ai/*` packages are not on the plugin's resolution path, so:

- `import { z } from 'zod'` → `ERR_MODULE_NOT_FOUND`
- `import Schema from '@deepseek-ai/schemastery'` → `ERR_MODULE_NOT_FOUND`
- the Host reports the entry as `failed to import` and the plugin never activates

Observed on 2026-10-07 with this plugin, and reproduced from the profile
directory with plain Node for both specifiers. The fix is structural: the Host
half imports **only** `node:` builtins and relative files. `lib/schema.js`
carries a ~60-line validator because the gateway only ever calls
`codec.create().parse(value)`; `whale-pet`, the one installed third-party plugin,
is self-contained for the same reason.

## Extending it

Three seams, all Host-side and all small:

- **A new provider** — one row in `lib/registry.js` (`id`, `label`, `kind`,
  `credentialRef`, `origin`). `kind: 'local'` means "reported, always $0".
- **A new rate card** — one entry in `lib/pricing.js` matching on the provider and
  model ids DSH records in session logs.
- **A new live balance** — a reader alongside `lib/balance.js` and a call from
  `index.js`; the report already carries a provider list and renders unready
  states instead of failing.

## Development

```sh
npm test              # extracts the shipped typert loader + schemastery from app.asar first
npm run report        # print this report in the terminal, live
npm run report -- --json --days 7
```

The suite runs shipped modules rather than reimplementations for the one gate
that is easy to get wrong: `lib/typert.host.js` goes through the archive's own
`validateTypertManifest`, the same check the Host applies when the plugin row
mounts. `lib/schema.js` is exercised against the real report in both directions
(accepts what `buildReport` produces, rejects drift), and the plugin is also
loadable and callable straight from the profile directory — the same anchor the
Host uses.

`tools/report.mjs` runs exactly the modules `index.js` wires together, so "the
panel shows nothing" can be told apart from "the numbers are wrong". It reads the
key from the launch environment, then from `~/.dsh/.credentials.yaml`; set
`DSH_ASAR` if the Harness is not at the default path.
