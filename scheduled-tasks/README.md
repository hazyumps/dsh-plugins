# dsh-plugin-scheduled-tasks

Scheduled tasks for DeepSeek Harness that start a **new session** per run, with
the task's own model, thinking level, and agent preset, then send the prompt.

DSH already ships an experimental *Automation tasks* page. That one delivers a
reminder back into the session that created it, reusing that session's model,
and cannot carry a per-task model or agent. This plugin is the other shape: a
task is a job definition, and each run is a fresh conversation.

Both can run at once; this plugin does not touch the shipped scheduler or its
stored tasks.

## What a task holds

| Field | Meaning |
|---|---|
| Task name | Row title and the prefix of each run's session title |
| Schedule | Daily, Weekdays, Weekly, Every N minutes/hours, Once, or a five-field cron |
| Time and timezone | Wall-clock time in a stored IANA zone |
| Model | Provider and model, from the Host's own model catalog |
| Thinking level | The model's reasoning effort; hidden for models without one |
| Agent | The agent preset the run's session is mounted with |
| Prompt | Sent verbatim when the run starts |
| Enabled | A disabled task keeps its history and stops firing |

A run is named `<task> — <YYYY-MM-DD>`, so the session list reads as the task's
own log.

## Install

In the DSH Web sidebar: **Plugins → Add plugin**, give it the absolute path to
this directory, then **Install** and **Enable now**.

The plugin needs the Web profile: it mounts on `ctx.sessionController`, which
the Web application provides and the base bundle does not.

## Settings

The page has a **Settings** tab beside the task list. These are the defaults a
new task inherits:

| Key | Default | Meaning |
|---|---|---|
| `cwd` | your home directory | Working directory, and therefore the workspace, of every run. Set this to the repository a run belongs to. |
| `provider`, `model`, `effort`, `preset` | empty | Used when the editor leaves a target field blank. |
| `importFromScheduler` | off | Carries DSH's own Automation tasks across once, the first time it is switched on with an empty list. A stored task this plugin cannot express — a one-shot delay — is skipped and logged. |

The import is a one-shot: it clears its own flag, and it only ever runs against
an empty task list, so it can neither duplicate nor overwrite anything.

Settings live in the plugin's own document, not in the profile patch, because a
plugin cannot ship a `Config` schema — see the note on dependencies below.

## How it works

- `lib/recurrence.js` — rule parsing and next-occurrence computation for
  `once`, `every`, `daily`, `weekly`, and five-field `cron`, including the
  wall-clock/DST handling. Its tests compare it **against the shipped
  scheduler** for the same inputs, so the two agree on every case they cover.
- `lib/job.js` — one task's rule, target, and run history.
- `lib/store.js` — the durable document, written atomically.
- `lib/scheduler.js` — one timer, one pass at a time, a caught-up pass on
  start, and the latest missed occurrence only.
- `lib/runner.js` — creates the session, installs the model, sends the prompt.
- `lib/service.js` — the single implementation of every operation.
- `lib/schema.js`, `lib/contract.js`, `lib/typert.host.js` — the durable record
  shape and the Remote namespace the editor calls.
- `lib/errors.js` — the wire error the gateway recognises by its marker.
- `client.js` — the sidebar entry, the task list, and the editor.

Tasks and settings are stored in `$DSH_HOME/storages/scheduled_tasks.json`.

## Dependencies, and why there are so few

This bundle imports **only Node built-ins, `zod`, and its own modules**.

A plugin installed into a profile cannot resolve `@deepseek-ai/*` packages at
runtime: they are not on npm, they are not in the profile's `node_modules`, and
the loader registers no fallback resolver. An import of one fails the whole
plugin at load. That is why recurrence is implemented here, why the durable
store is a plain JSON document, and why the settings live in that document
rather than in a `Config` schema.

Because the profile installs this directory as a **link**, the plugin's own
`node_modules` is what resolves `zod`. Run `pnpm install` in this directory
before installing the plugin into a profile.

## Verification

```
npm test
```

The suite covers the rule, target, and run-history helpers plus the scheduler's
due-order, failure, catch-up, re-entrancy, and timer behavior. It runs against
the **real** shipped recurrence code: `tools/sync-test-deps.mjs` extracts
`@deepseek-ai/dsh-schedule` and its Temporal dependency from the installed
`app.asar` into `tests/.fixtures/`, and `tests/loader.mjs` maps the bare
specifiers onto those copies. Re-run the extractor after a Harness upgrade.

## Known limits

- **The first run of a task changes the default model twice.** DSH's
  `sessionController.selectModel` also saves the selection as the user's global
  default. A background task must not decide which model your next session
  opens with, so the runner writes the previous default straight back. The run
  itself is unaffected — its selection is installed on the session, not read
  from the default. The cost is two profile writes per run.
- **Sessions accumulate.** One session per run is the point, but a daily task
  leaves 365 sessions a year. Nothing archives them.
- **No agent tools yet.** The service is reachable over its Remote namespace and
  from `ctx.scheduledTasks`, but it does not yet register `defineTool` entries,
  so the model cannot create a task by itself.
- **The Host must be running.** A missed occurrence is delivered on the next
  start, latest only.
- Recurring rules use this plugin's own record shape, so stored tasks are not
  interchangeable with the shipped scheduler's rows. The one-shot importer is
  the only bridge between them.

## Development

`docs/recon-host.md` and `docs/recon-client.md` record the installed Harness
APIs this plugin is built against, with file and line citations into the app
archive. `docs/recon-schedule.md` covers the scheduler exports.
