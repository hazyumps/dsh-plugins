# Host-side plugin API recon — scheduled tasks that start a new session

Recon of the **installed** DeepSeek Harness asar
(`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`,
installed 2026-09-29, packages at `0.2.0-rc.2`). Read-only; this file is the
only write.

## 0. Authority and method

| Source | Status |
|---|---|
| asar `/dsh/node_modules/@deepseek-ai/*` | **Authority.** Every signature below is copied from it. |
| `lib/types/*.d.ts` | **Not shipped.** 0 `.d.ts` files exist in the whole asar (verified with `find . -name '*.d.ts' \| wc -l` → `0`). Type-only interfaces are erased to `export {}`. |
| `lib/types/*.js` | Compiled JS with JSDoc intact — used for every method signature below. |
| `lib/typert.host.js` | **Wire authority.** Generated Zod schemas; used for exact request/response field names and literal unions. |
| `~/repo/deepseek-harness` checkout | **Unreliable. Do not use.** HEAD is `47f9438`, 2026-08-13, and its `packages/schedule/schedule` is `0.1.0-rc.5` with a legacy session-event `persistence.ts` and **no** cron, `parseCronInput`, `defineDomain`, or `storage.ts`. It has no `api-session-controller` package at all. The installed schedule replaced that design with a storage-domain store. |
| `~/.dsh/profiles/desktop/node_modules/dsh-plugin-whale-pet@0.2.9` | Working third-party host+client plugin, used as the Remote-namespace template. |

Reusable extractor: `node /tmp/asarx/x.js "/dsh/node_modules/@deepseek-ai/<pkg>" /tmp/recon/<pkg>`.

## 1. Blockers and hard parts (read first)

1. **`ctx.sessionController.selectModel()` mutates the deployment-wide default model.**
   `lib/types/commands.js:165` calls `ctx.agentDefaultModel.saveSelection(selected)`,
   which writes the `agent-default-model` row's `config` through the profile's
   `configEditor` (`@deepseek-ai/dsh-agent-default-model/lib/index.js:53-66`).
   Setting a per-job model therefore changes the user's global default.
   Mitigation: snapshot `ctx.agentDefaultModel.currentSelection()` before and call
   `saveSelection(previous)` after — fragile under concurrency. Clean alternative in §3B.
2. **`sessionController` is web-profile-only.** It is mounted by
   `dsh-web-app/cordis.patch.yml:121-122`, **not** `dsh-base`. `ctx.agents` and
   `ctx.sessions` are in `dsh-base`. A plugin that hard-injects
   `sessionController` fails to activate in the headless profile.
3. **The Remote namespace cannot be "registered" twice.** `ctx.typert.register()`
   is real and documented for hand-written schemas, but the manifest is validated
   strictly. Proven feasible — see §7.
4. **`jobs` / `jobController` are already taken.** `ctx.jobs`, `ctx.jobController`,
   `ctx.remote.job`, and tools `job_output`/`job_kill` are *background shell
   process* jobs (`dsh-jobs-local`, `dsh-api-job-controller`). Do not name the new
   service `jobs`.
5. **`sessionController.prompt` dedupes on `requestId`.** `lib/types/commands.js:301`
   returns `{accepted:true}` without running anything if that `requestId` already
   appears in the inbox or the session log. **Mint a fresh UUID per fire.**
6. **`sessionController.create` defaults `cwd` to `process.cwd()` of the DSH host**
   (`this.commands = new SessionCommandController(ctx, this.agents, process.cwd())`).
   Always pass an explicit `cwd`.
7. **`dsh-time-context` provides no injectable service.** It exports only
   `{Config, apply, inject, name}`; it registers a `timeContext` session projection
   and an `agent/pre-step` injector. There is no `ctx.timeContext`. The IANA zone is
   carried per prompt via `sessionController.prompt({clientTimeZone})`.

## 2. Service reference

### 2.1 `ctx.sessionController` — `@deepseek-ai/dsh-api-session-controller`

Registered `super(ctx, "sessionController", { namespace: "session" })`
(`lib/index.js:2847`). `static inject = ["agentDefaultModel","agents","attachments","fileUploads","fs","llm","sessions","sessionProjections","sessionQuery","typert","workspaceRegistry"]`.

Exact request/response shapes below are copied from `lib/typert.host.js`
(Remote wire contract); JSDoc from `lib/index.js`.

| Method | Request → Result |
|---|---|
| `create(request)` | `{ workspaceId?: string, cwd?: string, sessionId?: string, agentPreset?: string }` → `{ sessionId, agentPreset? }` |
| `selectModel(request)` | `{ sessionId, provider: string, model: string, reasoningEffort?: string }` → `{ selected: { provider, model, reasoningEffort? } }` |
| `prompt(request, signal)` | `{ requestId: string, sessionId: string, mode: 'queue'\|'steer', content: Content[], clientTimeZone?: string }` → `{ accepted: true }` |
| `resolveAgent(sessionId)` | → `Agent` (throws the stable `RemoteError` on failure) |
| `modelCatalog()` | → `{ default, routableProviders, groups: [{id,name,models:[{id,name,description?,reasoning?:{efforts:[{id,name,description?}],defaultEffort?}}]}], failures }` |
| `list(_request, signal)` / `search(request, signal)` / `page` / `follow` / `fork` / `rename` / `cancel` / `updateQueue` / `attachment` / `projections` / `control` | see `lib/index.js:2939-3185` |

`Content` (from the prompt wire schema):
```ts
Array<
  | { type: 'text';  text: string }
  | { type: 'image'; mediaType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif'; data: string; name?: string }
  | { type: 'file';  receiptId: string }
>
```
**Direct host call caveat:** the image/file arms are the *wire* encoding. Calling the
host service in-process bypasses typert validation and lands in
`resolvePromptFileReceipts` (`lib/types/commands.js:533`), which expects staged
attachments (`{type:'file', receiptId}` via `ctx.fileUploads`) and internal
`{type:'image', attachment}` refs. **Use `{type:'text'}` only.**

Import specifiers: `@deepseek-ai/dsh-api-session-controller` (root),
`/client`, `/typert`, `/remote`, `/types`. `buildModelCatalog` is exported from the root.

### 2.2 `ctx.agents` — `@deepseek-ai/dsh-agent`

`super(ctx, "agents")` (`lib/index.js:332`). Creation is delegated to whichever
plugin registers the factory (`dsh-agent-loop`). JSDoc verbatim:

```js
/**
 * Create and publish a new agent through the registered factory. ...
 * @param options - shared identity, optional live parent, session seed/metadata, and agent options.
 * @returns the handle after setup, rollback-covered publication, and loop start complete.
 */
async create(options)            // lib/index.js:451
async resume(options)            // lib/index.js:464
get(id)                          // -> Agent | undefined
list() / roots()                 // -> Agent[]
isOwnedBy(id, owner)             // -> boolean
withInitiator(agent, operation)  // lib/index.js:398
withoutInitiator(operation)      // lib/index.js:412
```

`ctx.agents.create(options)` resolves to a handle with `.agent`; `agent.session` is the
`Session`. `Agent` (from `dsh-agent-loop`) exposes `followup(input)`, `steer(input)`,
`inject(input)`, `cancel(cause, options?)`, `session`, `id`, `ctx`:

```js
followup(input) { this.send(input, "next-turn", true); }   // wakes the driver -> the agent runs
steer(input)    { this.send(input, "next-step", true); }   // dsh-agent-loop/lib/index.js:806-811
```

Model override at agent scope is exported from the root:
`installModelSelection(agentCtx, selection)` (`lib/types/model-selection.js`).

### 2.3 `ctx.llm` — `@deepseek-ai/dsh-llm`

`super(ctx, 'llm')`. Inject key `llm`.

```js
listProviders()                              // -> Provider[]
listModels(provider)                         // -> Model[]        lib/types/index.js:556
async resolveModelInfo(provider, model, signal)
  // -> { provider, id, name, description?, inputModalities?,
  //      context?: {contextWindow}, defaultMaxTokens?, systemPromptUpdate?, toolUpdate?,
  //      reasoning?: { efforts: [{id,name,description?}], defaultEffort? } }   :591, :599
async resolveCallConfig(config, signal)      // :687
  // config = { provider, model, reasoningEffort?, temperature?, maxTokens?, stop? }
  // -> detached config with the effort materialized; throws
  //    LlmError(code 'UNSUPPORTED_REASONING_EFFORT') when unsupported.
```

Reasoning effort is a **branded string, not a fixed union**:
`ReasoningEffortId(id)` = `brandString(id)`, "no validation is performed"
(`lib/types/brand.js`). The valid ids are **adapter-owned**. For
`dsh-llm-deepseek` they are exactly `"off" | "low" | "high" | "max"`
(`dsh-llm-deepseek/lib/index.js:452-455`). Validate at runtime via
`resolveCallConfig` (throws) or `resolveModelInfo(...).reasoning.efforts`.

Import specifiers: root, `/types`, `/brand`, `/message`, `/assistant-stream`, `/typert`, `/remote`.

### 2.4 `ctx.agentDefaultModel` — `@deepseek-ai/dsh-agent-default-model`

`super(ownerContext, "agentDefaultModel")`.

```js
currentSelection()      // -> { provider, model, reasoningEffort? }   detached
async saveSelection(next)  // writes the profile Config row via ctx.get('configEditor')
```
Shipped default in `dsh-base/cordis.patch.yml:82-86`:
`{ provider: deepseek-official, model: deepseek-flash }`.

### 2.5 `ctx.agentPresets` — `@deepseek-ai/dsh-agent-preset-registry`

`super(ctx, "agentPresets")`, `static inject = ["loader","sessionProjections"]`,
`Config = { default: string (required), selectedDefault?: string }`.

```js
async list()                 // -> [{id, name?, description?, order?, broken?}]  sorted
async remoteExportList()     // -> { presets: [...{isDefault}] }
async resolve(id?)           // -> { id, broken? }   throws RemoteError('agent-preset/not-found')
async mount(agentCtx, id?)   // -> { id }           binds the preset's child composition
readDocument(agentPreset)    // child plugin list as YAML
get defaultId()              // selectedDefault ?? default
```

**What a preset is:** a Cordis loader row (`@deepseek-ai/dsh-agent-preset`) with
`Config = { id: string(required), name?, description?, order?, plugins: any[](required) }`
(`dsh-agent-preset/lib/index.js`). Its `id` is a plain string — a whole child
composition (persona, tools, skills) mounted onto an agent context. Presets exist
only where a `dsh-agent-preset` row is loaded. In this deployment all four shipped
patches are applied by `dsh-web-app/package.json` `dsh.bundle.patch`, so
`standard`, `ptc`, `minimal`, `cordis` are registered, with
`agent-preset-registry` `config.default: standard`
(`dsh-web-app/cordis.patch.yml:558-565`).

If `agentPresets` is absent, `composeAgent` degrades to selection-only
(`lib/types/agent.js:388-401`) — presets are optional, never required.

### 2.6 `ctx.sessions` — `@deepseek-ai/dsh-session`

`super(ctx, "sessions")` (`lib/index.js:1621`).

```js
create(id?, options)        // -> live Session, already entered and announced
prepare(id?, options)       // -> Session, NOT yet in the store
enter(session)              // -> detach disposer
announce(session)
async flush(session)        // -> boolean: whether a durability listener participated
get(id)                     // -> Session | undefined
list()                      // -> Session[]
fork(source, boundary?, childSessionId?)
```

### 2.7 Durable storage — `dsh-storage` / `dsh-storage-domain` / `dsh-storage-json`

See §4. Injection keys: `ctx.storage` (hub), `ctx.storageDomain` (the domain data
form), `ctx.storage.backend` (named backend registry). `ctx.storage.domain` is a
getter for the same facility.

### 2.8 `ctx.tools` — `@deepseek-ai/dsh-tools`

`super(ctx, "tools")`, `static inject = ["systemPrompt"]`.
`register(definition) -> disposer` (`lib/index.js:2878`); `defineTool(options)` is
exported from the root. See §6.

### 2.9 `dsh-time-context` — no service

Exports `{ Config, apply, inject, name }` only. `inject = ["agents","sessionProjections"]`,
`Config = { timeZone: string, refreshIntervalMs: number }`. It registers the
`timeContext` session projection and prepends an `agent/pre-step` message. **UNCERTAIN**
whether any other package registers a `ctx.timeContext`; I grepped
`dsh-time-context/lib/index.js` in full and its export list is the four names above.

## 3. Create a session, choose its model/effort/preset, and send a prompt

### 3.A Recommended path — `ctx.sessionController`

```js
// inject: ['sessionController']  (web profile only — see blocker 2)
import { randomUUID } from 'node:crypto';

async function runJob(ctx, job) {
  // 1. Create the session. Pass cwd explicitly (blocker 6).
  //    Omit sessionId to mint a fresh `session-<uuid>`.
  //    agentPreset is resolved+mounted here; omitted -> registry default.
  const { sessionId, agentPreset } = await ctx.sessionController.create({
    cwd: job.cwd,                 // absolute path; mkdir -p is done for you
    ...(job.agentPreset === undefined ? {} : { agentPreset: job.agentPreset }),
  });

  // 2. Install the session-local model + reasoning effort.
  //    resolveCallConfig validates the effort and materializes the model default.
  //    SIDE EFFECT: also saves the deployment default model (blocker 1).
  const { selected } = await ctx.sessionController.selectModel({
    sessionId,
    provider: job.provider,
    model: job.model,
    ...(job.reasoningEffort === undefined ? {} : { reasoningEffort: job.reasoningEffort }),
  });

  // 3. Admit the prompt. mode 'queue' -> agent.followup() -> the agent runs.
  //    requestId MUST be unique per fire (blocker 5).
  const { accepted } = await ctx.sessionController.prompt({
    requestId: randomUUID(),
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: job.prompt }],
    ...(job.timeZone === undefined ? {} : { clientTimeZone: job.timeZone }), // IANA
  }, new AbortController().signal);

  return { sessionId, agentPreset, selected, accepted };
}
```

Order is load-bearing: `selectModel` resolves the agent (`resolveAgent`) and appends
a durable `model/selection` event; `prompt` then resolves the same live agent and
calls `agent.followup(message)`. `prompt` does **not** wait for the turn to finish —
it returns once the message is admitted. That matches the scheduler contract in
`lib/scheduler.js` ("must not wait for the agent to finish").

Every field above is verified in `lib/types/commands.js`:
`create` at `:107`, `selectModel` at `:145`, `prompt` at `:290`.

### 3.B Path that avoids blocker 1 (lower-level, more code)

Reimplements what `selectModel` does minus the global save:

```js
import { installModelSelection } from '@deepseek-ai/dsh-agent';

const { sessionId } = await ctx.sessionController.create({ cwd: job.cwd });
const found = await ctx.sessionController.resolveAgent(sessionId);
if ('error' in found) throw found.error;
const agent = found.agent;

const resolved = await ctx.llm.resolveCallConfig({
  provider: job.provider, model: job.model,
  ...(job.reasoningEffort === undefined ? {} : { reasoningEffort: job.reasoningEffort }),
});
// Durable record: the same event sessionController.selectModel appends.
agent.session.append('model/selection', resolved);
// Apply to the next request assembly.
installModelSelection(agent.ctx, { get current() { return resolved; }, assembled: undefined });
```

**UNCERTAIN:** whether `installModelSelection` registered a second time on the same
`agent.ctx` (the controller already installed one during creation) reliably wins the
`agent/request` waterfall. I read the waterfall in
`dsh-agent/lib/types/model-selection.js` and both listeners rewrite
`provider`/`model`/`reasoningEffort`, so the later registration should win, but I did
not execute it. Prefer 3.A, or test 3.B before relying on it.

### 3.C Custom prompt provenance

`sessionController.prompt` hardcodes `source = { kind: 'user', rpcId: requestId }`
(`lib/types/commands.js:303-307`). To mark the prompt as job-originated, bypass
`prompt` and do what `dsh-schedule` does
(`dsh-schedule/lib/index.js:1586-1596`):

```js
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const agent = /* resolved via ctx.sessionController.resolveAgent(sessionId) */;
const message = createUserMessage({
  content: [{ type: 'text', text: job.prompt }],
  source: { kind: 'scheduled-task' },     // any non-empty kind is legal for user/message
});
agent.followup(message);
await ctx.sessions.flush(agent.session);  // durability ack before recording success
```

`assertMessageEventShape` (`dsh-session/lib/index.js:1202`) only requires a
non-empty `source.kind` string for `user/message`; the strict kind checks apply to
`system-prompt`, `model`, and `tool` sources only.

## 4. Durable storage for the plugin's own JSON

**Inject key:** `ctx.storageDomain` (`@deepseek-ai/dsh-storage-domain`).
Hub is `ctx.storage` (`@deepseek-ai/dsh-storage`).

Wire-up in `dsh-base/cordis.patch.yml:161-176`:
`storage` (hub) → `storage-json` with `config.root = dshHomePath('storages')` →
`storage-domain` with `config.backend: 'json'` and **no `routes`**, so every
declared domain defaults to the `json` backend.

### Domain spec

`defineDomain({ name, version, tables, global?, layout?, compatibleVersions?, invalidRecords? })`
(`dsh-storage-domain/lib/index.js:61`), `domainTable(schema)` where the record schema
is **zod** (`:46`). `name`/table names must match `/^[a-z][a-z0-9_]*$/`.
`Domain.close()` is owned by the caller — do it in your own `ctx.effect` disposer.

### Open + read/write

```js
import { z } from 'zod';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';

export const jobDomain = defineDomain({
  name: 'scheduled_tasks',
  version: 1,
  tables: { jobs: domainTable(z.object({ /* … */ })) },
});

export function apply(ctx) {
  ctx.effect(async () => {
    const domain = await ctx.storageDomain.open(jobDomain);
    const jobs = domain.table('jobs');           // -> stable table handle

    jobs.get('job-1');                            // sync, from memory
    [...jobs.entries()];                          // IterableIterator<[key, value]>
    jobs.size;
    await jobs.put('job-1', record);              // durable FIRST, then memory
    await jobs.delete('job-1');                   // -> boolean
    await jobs.update('job-1', (prev) => next);   // -> next
    jobDomain.global;                             // only when spec declares `global`

    return () => domain.close();
  }, 'scheduled-tasks.store');
}
```

Semantics worth knowing (`dsh-storage-domain/lib/index.js:93-297`):
reads are synchronous from memory; every write queues on one per-domain chain and
**awaits backend durability before mutating memory**, so a rejected write leaves
memory untouched. `put`/`delete`/`update` emit `domain/changed`. Only one open per
domain name — `open()` throws `DomainError('already-open')`.

### On disk

`dsh-storage-json` `Config = { root: string (required) }`, wired to
`dshHomePath('storages')` = `~/.dsh/storages`. Layout is chosen by the spec's
`layout`: `'per-record'` → a directory `<root>/<name>/<table>/<key>.json`
(keys restricted to `/^[a-zA-Z0-9_-]+$/`); otherwise **`single`** → one whole-unit
document `<root>/<name>.json`. `scheduleDomain` uses the default (single), and the
live file is `~/.dsh/storages/schedule.json` — confirmed on disk. Writes are atomic
(temp file + `rename` + directory fsync). A version stamp mismatch rejects with
`StorageError('version-mismatch')`.

## 5. `@deepseek-ai/dsh-schedule` — reusable recurrence parsing

**Yes.** `exports` has no subpath for helpers, but the root re-exports them, so
`import { … } from '@deepseek-ai/dsh-schedule'` works. `exports` map:
`"."`, `"./invariant"`, `"./client"`, `"./src/*"`, `"./package.json"`,
`"./locale/*.json"`, `"./typert"`, `"./remote"`.

Full root export list (verbatim, `lib/index.js:2910`):

```
MAX_TITLE_LENGTH, MIN_EVERY_INTERVAL_SECONDS, SCHEDULE_CHANGE_VERSION, ScheduleId,
ScheduleInputError, ScheduleLogError, ScheduleService, ScheduleService as default,
canonicalizeCronExpression, createAfterScheduleRecord, createAtScheduleRecord,
createCronScheduleRecord, createDailyScheduleRecord, createEveryScheduleRecord,
createWeeklyScheduleRecord, decodeScheduleChange, decodeScheduleRecord,
foldScheduleEvents, isRecurringScheduleRecord, normalizeWeekdays, parseCronInput,
parseWeeklyInput, registerScheduleTools, renderRecurringReminderBatchFraming,
renderReminderFraming, resolveCronOccurrence, resolveDailyOccurrence,
resolveEveryOccurrence, resolveRecurringOccurrence, resolveWeeklyOccurrence,
scheduleDomain, scheduleTitle, scheduleView, weeklyTime
```

**NOTE:** the installed schedule ships **no `.d.ts`**, so these symbols have no type
declarations at runtime — but `dsh-schedule` *is* a shipped package, so an
in-profile plugin may import it without declaring a dependency.

### `ctx.schedule` service

`super(ctx, "schedule")` (`lib/index.js:2614`),
`static inject = ["agents","sessions","tools","storageDomain","sessionController","sessionPersistence"]`.

```js
/**
 * Create a reminder bound to the caller-selected Session without activating it. ...
 * @param sessionId - Original Session receiving the reminder.
 * @param request - Validated tool selector, required title, and reminder content.
 * @param signal - Optional cancellation checked before persistence begins, including after FIFO waits.
 * @returns The durably stored schedule. Cancellation does not roll back an in-flight write.
 */
async create(sessionId, request, signal)      // lib/index.js:2720

async list(request)      // { sessionId } -> ScheduleRecord[]        :2755
async catalog()          // -> [{...record, sessionId, status, lastDelivery?}]  :2764
async history(request)   // { sessionId, id, limit (1..100), before? }  :2779
async delete(request, signal)   // { sessionId, id } -> {id, deleted, code?}    :2797
async update(request, signal)   // { sessionId, id, expected, change, ... }     :2827
async stopSessionTasks(sessionId)                                              :2881
```

`request` for `create` — **exactly one** of the six selectors, plus required `title`
and `prompt` (`validateCreateArgs`, `:1940`):

```ts
{
  title: string;            // required, non-empty after trim, <= 120 chars
  prompt: string;           // required, non-empty after trim
  at?: string;              // RFC 3339 with explicit offset
  after_seconds?: number;   // positive safe integer
  every_seconds?: number;   // safe integer >= 60
  daily?:  { time: 'HH:mm:ss[.SSS]', time_zone: string };   // exact keys
  weekly?: { time: string, time_zone: string, weekdays: number[] };  // ISO 1=Mon..7=Sun
  cron?:   { expression: string, time_zone: string };       // 5-field Vixie
}
```

The `create` selectors accept **snake_case** (`after_seconds`, `every_seconds`,
`time_zone`); the stored record uses **camelCase**:

| `kind` | record fields (all frozen; all carry `id`, `kind`, `title`, `prompt`, `scheduledAt` ISO-8601 UTC) |
|---|---|
| `after` | `afterSeconds` |
| `at` | — |
| `every` | `everySeconds` |
| `daily` | `time`, `timeZone` |
| `weekly` | `time`, `timeZone`, `weekdays` |
| `cron` | `expression`, `timeZone` |

`createXScheduleRecord(id, prompt, <selector>, now, title)` and
`resolveRecurringOccurrence(record, acceptedAt) -> { occurrenceAt, nextScheduledAt? }`
(`lib/types/domain.js:853`, `:945`; `isRecurringScheduleRecord` at `:936`) are the
pure helpers already used by `lib/job.js` in this repo.

Error codes on `ScheduleInputError` (`.code`): `invalid_prompt`, `invalid_selector`,
`invalid_rule`, `invalid_time_zone`, `not_future`, `time_out_of_range`,
`frequency_too_high`, `internal_error`.

**Design gap:** `ctx.schedule` binds a schedule to an **existing** `sessionId` and
delivers into it (`resolveAgent(task.sessionId)` → `followup`, `:1576-1596`). It does
**not** create a session, and it sets no model, effort, or preset. Our plugin's whole
point — a *new* session per fire — is what must be built, while reusing its
recurrence records, DST semantics, storage-domain pattern, and `?/typert` layout.

## 6. Agent tools

`ctx.tools.register(defineTool({...}))` returns a disposer. Register on the **agent's
own context** inside an `agent/created` listener, and keep that disposer in your own
effect (`references/practices.md`). Minimal working example, shape copied from
`dsh-schedule/lib/index.js:2116-2150`:

```js
import { defineTool } from '@deepseek-ai/dsh-tools';

function registerJobTools(rootCtx, agentCtx, agent) {
  return agentCtx.tools.register(defineTool({
    name: 'job_list',
    description: 'List the scheduled tasks that start a new session.',
    parameters: {},
    output: { schema: { type: 'array', items: { type: 'object' } },
              render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      if (exec.agent !== agent) return { code: 'internal_error' };
      if (exec.signal.aborted) return { code: 'internal_error' };
      return await rootCtx.scheduledTasks.list({});
    },
    presentCall: () => ({ card: 'generic', title: 'List scheduled tasks', kind: 'read' }),
  }));
}

// wiring
ctx.on('agent/created', ({ agent }) => {
  if (!ctx.agents.roots().includes(agent)) return;      // top-level only
  const dispose = agent.ctx.effect(() => registerJobTools(ctx, agent.ctx, agent));
  // also keep `dispose` in this plugin's own effect, keyed by agent
});
```

Each `parameters` entry is `{ type, required?, description?, enum?, items? }`.
`exec` carries `{ agent, signal }`. `defineTool` validates the name and
`timeoutMs`; it is exported from `@deepseek-ai/dsh-tools` root.

## 7. Typert Remote namespace by hand — yes, and it is already proven

Two supported routes:

**(a) Package artifact (auto-registered).** Add `"./typert": "./lib/typert.host.js"`
to `package.json` `exports`. `@deepseek-ai/dsh-typert-loader` resolves the export when
the loader entry mounts and calls `ctx.typert.register(manifest)`; it withdraws the
registration on unmount (`dsh-typert-loader/lib/index.js:7-31`, `:300`). **This is what
`dsh-plugin-whale-pet@0.2.9` does, and it is installed and working in
`~/.dsh/profiles/desktop`.**

**(b) Manual.** The loader's own docstring: *"Manual `ctx.typert.register()` remains
available for contributions that do not use a `./typert` artifact (hand-written wire
schemas, tests, non-loader compositions)."*

### Host service binding

```js
// lib/index.js (whale-pet, verbatim shape)
export const name = 'whalePet';
export const inject = ['agents'];

export function apply(ctx) {
  const service = { watch(signal) { return hub.watch(signal); } };
  // Public Cordis service + the exact visible protocol binding.
  service.typertRemote = Object.freeze({ service, serviceKey: name, namespace: name });
  ctx.provide(name, service);
}
```
(`~/.dsh/profiles/desktop/node_modules/dsh-plugin-whale-pet/lib/index.js:101-112`.)
`bindTypertRemote(service, serviceKey, options?)` from
`@deepseek-ai/dsh-typert-protocol` produces that same frozen
`{ service, serviceKey, namespace }`, and `TypertRemoteService` is the `Service`
subclass that does it automatically (`dsh-typert-protocol/lib/index.js:146-170`).

### Manifest — `lib/typert.host.js`

```js
import { WHALE_WATCH_DESCRIPTOR, WHALE_FRAME_SCHEMA } from './remote.js';

export const TYPERT = {
  package: 'dsh-plugin-whale-pet',
  face: 'host',
  schemas: [{ name: 'WhaleBoundaryFrame', create: () => WHALE_FRAME_SCHEMA }],
  invocations: [WHALE_WATCH_DESCRIPTOR],
  model: {
    services: [{
      key: 'whalePet', exportName: 'WhalePetBoundaryService',
      description: '…', summary: '…', tags: [],
      members: [{ kind: 'method', name: 'watch',
                  signature: 'watch(signal: AbortSignal): AsyncIterable<WhaleBoundaryFrame>' }],
      types: [],
    }],
    events: [], objects: [],
  },
};
export default TYPERT;
```

### `InvocationDescriptor`

Verbatim (`lib/remote.js:1336-1346`):

```js
var WHALE_WATCH_DESCRIPTOR = {
  id: "dsh-plugin-whale-pet#whalePet/watch",
  service: "whalePet",
  namespace: "whalePet",
  method: "watch",
  mode: "stream",                                  // omit for unary
  invocation: { kind: "direct" },                  // or { kind: "context", context, wire, codec }
  parameters: [],
  cancellation: { parameter: "signal" },
  result: { mode: "strict",
            typeSymbol: "dsh-plugin-whale-pet#WhaleBoundaryFrame",
            create: () => WHALE_FRAME_SCHEMA }
};
```

A parameterized (unary) invocation, copied from
`dsh-schedule/lib/typert.host.js:380-400`:

```js
{
  id: '@deepseek-ai/dsh-schedule#schedule/delete',
  service: 'schedule', namespace: 'schedule', method: 'delete',
  invocation: { kind: 'direct' },
  parameters: [{
    name: 'request', wire: 'request', source: 'json',
    codec: { mode: 'strict',
             typeSymbol: '@deepseek-ai/dsh-schedule/client#ScheduleDeleteRequest',
             create: _schedule_delete_parameter_0$schema },
  }],
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-schedule/client#ScheduleDeleteResult',
            create: _schedule_delete_result$schema },
}
```

### What the loader validates

`validateTypertManifest` (`dsh-typert-loader/lib/index.js:77-205`) enforces:
`manifest.package` **must equal the exporting package name**; `face === 'host'`;
`schemas` an array of `{ name, create(): schema }`; `model.services[]` with
`key`/`exportName`/`members[{name,signature,kind}]`/`types`; `model.events[]` with
`name`/`signature`; `model.objects[]`; every invocation with non-empty
`id`/`service`/`namespace`/`method`, `invocation.kind` in `direct|context`,
parameters with unique `wire` and `source` in `json|lookup`, and every codec
`mode: 'strict'` with `typeSymbol` + `create()`.

### Client half

`package.json` gains `"dsh": { "client": { "platform": "web", "inject": [...] } }`
and a `"./client"` export. The Client bundle is loaded by
`window.__ModuleLoader__.load({ id, factory })` and calls
`ctx.remote.<namespace>.<method>(request)`; the namespace key must be listed in the
client module's `inject` array (e.g. `inject = ["slots","locale","remote",
"remote.schedule", …]`, `dsh-client-ui-schedule/lib/client.js:6686-6697`), and events
arrive via `ctx.remote.$on("schedule/changed", listener)`. Note the Host plugin must
*also* export a node-side `apply` even when the behaviour is browser-only
(`dsh-client-ui-schedule/lib/index.js` is an empty `apply()`).

## 8. Packaging and install (as shipped)

Host-only bundle manifest, from `references/host-plugin.md`:

```json
{ "name": "@local/my-plugin", "version": "1.0.0", "private": true,
  "type": "module", "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```
```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

`index.js` exports **one of**: `apply(ctx, config)` + optional `export const inject`
and `export const Config`, **or** a service class as the default export. Register
everything inside `apply` via `ctx.effect`/`ctx.on` and return cleanup.

Installed with the `plugin_manager` tool
(`dsh-plugin-manager/lib/types/tools.js:16`): actions `list_plugins`, `list_bundles`,
`set_plugin`, `set_bundle`, `install_bundle`, `remove_bundle`,
`list_version_exemptions`, `set_version_exemption`; `install_bundle` takes `target`
(absolute package directory or spec) plus `approvedBuilds` only after explicit user
approval. **Do not** hand-write the profile `package.json` / `cordis.patch.yml` or run
pnpm in the profile directory. Runtime introspection is `cordis_inspect_list` then
`cordis_inspect_query` (`dsh-tool-cordis/lib/index.js:40,56`).

## 9. Uncertainties

Every item below is flagged where it appears above; nothing else in this document is
unverified.

- **`installModelSelection` re-registration ($3.B).** UNCERTAIN whether a second
  registration on an `agent.ctx` that already has the controller's wins the
  `agent/request` waterfall. Read the waterfall; did not execute. Prefer §3.A.
- **`ctx.timeContext` existence ($2.9).** UNCERTAIN as a negative: I read
  `dsh-time-context/lib/index.js` in full and its export list is
  `{Config, apply, inject, name}`, so it provides no service. I did not grep all 290
  packages for another `provide('timeContext')`.
- **Whether `resolveCallConfig`'s returned object is a legal `model/selection`
  payload ($3.B).** UNCERTAIN — `selectModel` appends exactly
  `{provider, model, reasoningEffort?}` (`lib/types/commands.js:157-164`); I assumed
  the fuller resolved config is also accepted. Did not execute.
- **Live preset roster in the *desktop* profile.** UNCERTAIN. `dsh` is not on PATH in
  this session (`dsh: command not found`), so `--dump-config` could not be run. I
  inferred `standard|ptc|minimal|cordis` from
  `dsh-web-app/package.json` `dsh.bundle.patch` plus
  `agent-preset-registry` `config.default: standard`. Confirm with
  `cordis_inspect_query` on `Config` at runtime.
- **Exact behaviour of the plugin during a DST gap/overlap.** Not investigated —
  delegated entirely to `dsh-schedule`'s exported `createXScheduleRecord` /
  `resolveRecurringOccurrence`.
- **The `~/repo/deepseek-harness` checkout.** UNCERTAIN in the *unsafe* direction: it
  is 2026-08-13 and its schedule is `0.1.0-rc.5`. Any signature taken from it must be
  re-derived from the asar. This document takes nothing from it.
