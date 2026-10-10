/**
 * Scheduled tasks — the browser half.
 *
 * A classic-script DSH client plugin: it mounts the `scheduledTasks` Remote
 * namespace (the same descriptor ids the Host registers through `./typert`),
 * adds a sidebar entry, and renders the task list / editor page.
 *
 * Ground rules this file follows (recon-client.md §2, §4, §5, §9):
 *   - `id` MUST equal the package name or the loader row never resolves.
 *   - No `import`, no bundler, and never `require` an `@deepseek-ai/dsh-client-*`
 *     package: a throw there blanks the slot entry.
 *   - Everything visible goes through `ctx.locale`; everything styled uses the
 *     host's `--dsw-*` theme tokens (never `--dsw-alias-bg-layer-4`, which the
 *     shipped stylesheet references but does not define).
 *   - All side effects live in `apply(ctx)` and are registered through
 *     `ctx.effect` / `ctx.on` with a cleanup returned.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-scheduled-tasks',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    /** Must equal `package.json`'s `name`; the Typert loader asserts it. */
    const PACKAGE = 'dsh-plugin-scheduled-tasks';
    /** Remote namespace / Host service key (lib/contract.js `NAMESPACE`). */
    const NAMESPACE = 'scheduledTasks';
    /** Locale namespace, shared by both slot registrations. */
    const NS = 'scheduled-tasks';
    /** `main` is a keyed slot (options.key); `sidebar.panellist` is a list
     *  slot (options.id). The sidebar shell owns the click — the two values
     *  matching is the whole wiring. */
    const PANEL_ID = 'scheduled-tasks';
    /** How long to wait for the mounted namespace to become injectable. */
    const NAMESPACE_TIMEOUT_MS = 10000;
    /** Unique html id for the timezone datalist (only one panel exists). */
    const TIMEZONE_LIST_ID = 'st-timezones';

    /** ISO weekdays: 1 = Monday … 7 = Sunday (dsh-schedule normalizes to this). */
    const WEEKDAY_IDS = [1, 2, 3, 4, 5, 6, 7];
    const WEEKDAY_PRESET = [1, 2, 3, 4, 5];

    // ---------------------------------------------------------------------
    // Locale
    // ---------------------------------------------------------------------

    const en = Object.freeze({
      'panel': 'Scheduled tasks',

      'page.title': 'Scheduled tasks',
      'page.subtitle': 'Run a prompt on a schedule in a fresh session, with its own model, thinking level, and agent.',

      'action.new': 'New task',
      'action.edit': 'Edit',
      'action.delete': 'Delete',
      'action.deleteConfirm': 'Delete',
      'action.runNow': 'Run now',
      'action.save': 'Save',
      'action.saving': 'Saving…',
      'action.cancel': 'Cancel',
      'confirm.delete': 'Delete this task?',

      'col.task': 'Task',
      'col.schedule': 'Schedule',
      'col.target': 'Model',
      'col.state': 'State',
      'col.lastRun': 'Last run',
      'col.nextRun': 'Next run',
      'col.actions': 'Actions',

      'state.enabled': 'Enabled',
      'state.disabled': 'Disabled',

      'lastRun.never': 'Never run',
      'lastRun.ok': 'OK',
      'lastRun.failed': 'Failed',

      'nextRun.paused': 'Not scheduled',

      'list.empty': 'No scheduled tasks yet.',
      'status.loading': 'Loading…',

      'model.default': 'Default',

      'aria.toggle': 'Enable or disable {title}',

      'editor.create': 'New scheduled task',
      'editor.edit': 'Edit scheduled task',
      'editor.convertAfter': 'The stored rule is a one-off delay. Saving replaces it with the interval below.',

      'tab.tasks': 'Tasks',
      'tab.settings': 'Settings',
      'tabs.aria': 'Tasks and settings',

      'settings.title': 'Settings',
      'settings.subtitle': 'The defaults every new run inherits.',
      'settings.workspace': 'Workspace',
      'settings.workspaceHint': 'The run joins this workspace. With none chosen, the directory below decides where it lands.',
      'settings.cwd': 'Working directory',
      'settings.cwdHint': 'Used when no workspace is chosen above.',
      'settings.defaults': 'Default run target',
      'settings.defaultsHint': 'A task created with an empty target inherits these.',
      'settings.import': 'Import tasks from the Automation tasks page',
      'settings.importHint': 'Runs once, only into an empty list, and then clears itself.',
      'settings.unavailable': 'Settings could not be loaded, so this form starts empty.',
      'action.saveSettings': 'Save settings',
      'notice.settingsSaved': 'Settings saved.',
      'error.cwd': 'Enter a working directory.',
      'target.inherited': 'Inherits the plugin settings',

      'field.name': 'Task name',
      'field.nameHint': 'Leave blank to use the first line of the prompt.',
      'field.scheduleType': 'Schedule type',
      'field.time': 'Time',
      'field.timeHint': '24-hour HH:mm:ss, for example 07:00:00.',
      'field.weekdays': 'Days',
      'field.interval': 'Repeat every',
      'field.onceDate': 'Date',
      'field.onceDateHint': 'YYYY-MM-DD.',
      'field.onceTime': 'Time of day',
      'field.cron': 'Cron expression',
      'field.cronHint': 'Five fields: minute hour day-of-month month day-of-week.',
      'field.timezone': 'Timezone',
      'field.timezoneHint': 'IANA zone, for example America/Chicago.',
      'field.model': 'Model',
      'field.effort': 'Thinking level',
      'field.agent': 'Agent',
      'field.agentHint': 'The agent preset the new session starts with.',
      'field.workspace': 'Workspace',
      'field.workspaceHint': 'Where this task’s sessions are filed. Inherit uses the plugin setting.',
      'field.prompt': 'Prompt',
      'field.promptHint': 'Sent as the first message of the new session.',
      'field.enabled': 'Enabled',
      'field.enabledHint': 'A disabled task keeps its settings but never runs.',
      'field.providerPlaceholder': 'provider id',
      'field.modelPlaceholder': 'model id',
      'placeholder.time': '07:00:00',
      'placeholder.date': '2026-10-08',
      'placeholder.cron': '0 7 * * 1-5',
      'placeholder.zone': 'America/Chicago',
      'placeholder.cwd': '/Users/you/project',

      'option.defaultProvider': 'Provider default',
      'option.defaultModel': 'Model default',
      'option.providerDefault': 'Provider default',
      'option.defaultAgent': 'Default agent',
      'option.noWorkspace': 'None (use the directory below)',
      'option.inheritWorkspace': 'Inherit the plugin setting',

      'type.daily': 'Daily',
      'type.weekdays': 'Weekdays (Mon–Fri)',
      'type.weekly': 'Weekly',
      'type.everyMinutes': 'Every N minutes',
      'type.everyHours': 'Every N hours',
      'type.once': 'Once (date and time)',
      'type.custom': 'Custom (cron)',

      'typeHint.daily': 'Runs every day at the time below.',
      'typeHint.weekdays': 'Runs Monday through Friday at the time below.',
      'typeHint.weekly': 'Runs on the days you pick, at the time below.',
      'typeHint.everyMinutes': 'Runs at a fixed interval, starting from the moment you save.',
      'typeHint.everyHours': 'Runs at a fixed interval, starting from the moment you save.',
      'typeHint.once': 'Runs once at that date and time, then stops.',
      'typeHint.custom': 'Five fields: minute hour day-of-month month day-of-week.',

      'unit.minutes': 'minutes',
      'unit.hours': 'hours',

      'weekday.1': 'Mon',
      'weekday.2': 'Tue',
      'weekday.3': 'Wed',
      'weekday.4': 'Thu',
      'weekday.5': 'Fri',
      'weekday.6': 'Sat',
      'weekday.7': 'Sun',

      'schedule.daily': 'Daily at {time} {zone}',
      'schedule.weekdays': 'Mon–Fri at {time} {zone}',
      'schedule.weekly': 'Weekly on {days} at {time} {zone}',
      'schedule.everyMinutes': 'Every {count} min',
      'schedule.everyHours': 'Every {count} h',
      'schedule.everySeconds': 'Every {count} s',
      'schedule.cron': 'Cron “{expression}” ({zone})',
      'schedule.once': 'Once on {instant}',
      'schedule.after': 'Once, {seconds} s after creation',
      'schedule.unknown': '{kind} schedule',

      'ago.justNow': 'just now',
      'ago.minutes': '{n} min ago',
      'ago.hours': '{n} h ago',
      'ago.days': '{n} d ago',

      'notice.created': 'Task created.',
      'notice.saved': 'Task saved.',
      'notice.deleted': 'Task deleted.',
      'notice.started': 'Started session {id}.',

      'error.prompt': 'Enter a prompt.',
      'error.time': 'Time must look like 07:00 or 07:00:00.',
      'error.zone': 'Enter an IANA timezone, for example America/Chicago.',
      'error.weekdays': 'Pick at least one day.',
      'error.interval': 'Enter a positive number.',
      'error.date': 'Enter a date as YYYY-MM-DD.',
      'error.cron': 'A cron expression needs five fields.',
      'error.unknown': 'The request failed.',

      'catalog.unavailable': 'Model list unavailable ({message}). Enter the provider and model by hand.',
      'catalog.empty': 'No models were reported. Enter the provider and model by hand.',
      'catalog.stale': 'Model list unavailable ({message}). Keeping the current selection.',
      'presets.unavailable': 'Agent presets unavailable ({message}).',
    });

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

    /**
     * One invocation descriptor. Ids, parameter names and type symbols MUST
     * match `lib/contract.js`'s `descriptors(schemaFor)` exactly: the Host
     * registered the same set, and duplicate or mismatched ids are rejected.
     */
    function descriptor(method, parameterTypes, resultType) {
      return {
        id: `${PACKAGE}#${NAMESPACE}/${method}`,
        service: NAMESPACE,
        namespace: NAMESPACE,
        method,
        invocation: { kind: 'direct' },
        parameters: parameterTypes.map((symbol) => ({
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: strictCodec(symbol),
        })),
        result: strictCodec(resultType),
      };
    }

    const CONTRIBUTION = Object.freeze({
      package: PACKAGE,
      descriptors: [
        descriptor('list', [], 'TaskListResult'),
        descriptor('settings', [], 'SettingsResult'),
        descriptor('saveSettings', ['SettingsUpdateRequest'], 'SettingsResult'),
        descriptor('workspaces', [], 'WorkspaceListResult'),
        descriptor('create', ['TaskCreateRequest'], 'TaskResult'),
        descriptor('update', ['TaskUpdateRequest'], 'TaskResult'),
        descriptor('delete', ['TaskDeleteRequest'], 'TaskDeleteResult'),
        descriptor('runNow', ['TaskRunRequest'], 'TaskRunResult'),
      ],
    });

    // ---------------------------------------------------------------------
    // Remote plumbing
    // ---------------------------------------------------------------------

    /** A normalized Remote failure, shaped like the real `{ok:false,error}`. */
    function failure(code, message) {
      return { ok: false, error: { code, message } };
    }

    /** @returns `{code, message}` for a thrown value. */
    function describeError(error, fallbackCode) {
      if (error !== null && typeof error === 'object') {
        const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : fallbackCode;
        const message = typeof error.message === 'string' && error.message.length > 0
          ? error.message
          : String(error);
        return { code, message };
      }
      return { code: fallbackCode, message: String(error) };
    }

    /**
     * Call one method on a resolved namespace service.
     *
     * A unary Remote call resolves with `{ok:true,value}` or `{ok:false,error}`
     * for every carrier problem. Only an assembly fault (a missing method, a
     * withdrawn contribution) rejects, so that is folded into the error branch
     * rather than left to blow up a React render.
     */
    async function invoke(service, method, request) {
      try {
        const fn = service[method];
        if (typeof fn !== 'function') {
          return failure(
            'gateway/invocation-unavailable',
            `the ${NAMESPACE} namespace has no "${method}" method`,
          );
        }
        return await (request === undefined ? fn.call(service) : fn.call(service, request));
      } catch (error) {
        const described = describeError(error, `${PACKAGE}/failed`);
        return failure(described.code, described.message);
      }
    }

    /**
     * One `$mount` per root Context.
     *
     * `ctx.remote` hands back a fresh traced wrapper on every read, so keying on
     * `ctx.root` is what makes "mount once" true. The entry is ref-counted so a
     * second activation in the same root never pulls the namespace out from
     * under the first.
     */
    const MOUNTS = new WeakMap();

    /**
     * Wait for the mounted namespace to appear as its own Cordis service.
     *
     * `$mount` installs the descriptors; the namespace itself is a traced child
     * service (`remote.scheduledTasks`) that is not necessarily readable in the
     * same tick, so wait for it through `ctx.inject` — the pattern the shipped
     * whale-pet bridge uses. The returned `dispose` drops the scope.
     *
     * @param ctx - The client Context owning the mount.
     * @param timeoutMs - Fail rather than hang when the namespace never lands.
     * @returns `Promise<{service, dispose}>`.
     */
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
        // A synchronously activated child can already have been abandoned here.
        if (abandoned) drop();
      });
    }

    /**
     * Acquire (or share) the namespace mount for this root.
     * @param ctx - The client Context.
     * @returns `{ ready: Promise<service>, failed, release() }`.
     */
    function acquireMount(ctx) {
      const owner = ctx.root || ctx.remote;
      let entry = MOUNTS.get(owner);

      if (entry === undefined || entry.failed || entry.closed) {
        const previous = entry === undefined ? null : entry.closing;
        entry = {
          refs: 0,
          closed: false,
          failed: false,
          scope: null,
          unmount: null,
          closing: undefined,
        };
        // `$mount` installs LOCAL descriptors only; it does not check Host
        // readiness. Serialize behind any pending unmount of a dead entry.
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
        // Nothing may be awaiting `ready` yet; never leave it unobserved.
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
          // Zero-ref transitions can overlap before `ready` settles; serialize
          // cleanup so a successor waits for the real unmount.
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

    /**
     * The `scheduledTasks` caller. `$mount` is asynchronous, so every call waits
     * for the lease first and a mount failure becomes an ordinary `{ok:false}`.
     */
    function tasksCaller(lease) {
      return {
        call(method, request) {
          return lease.ready.then(
            (service) => invoke(service, method, request),
            (error) => {
              const described = describeError(error, `${PACKAGE}/unavailable`);
              return failure(described.code, described.message);
            },
          );
        },
      };
    }

    /**
     * A caller for a namespace this plugin does NOT own (`session`,
     * `agentPresets`). They are read opportunistically and are deliberately not
     * in `inject`: a composition without them degrades to an empty picker
     * instead of disabling the whole panel.
     */
    function shippedCaller(ctx, namespace) {
      return {
        call(method, request) {
          const service = ctx.remote === undefined || ctx.remote === null ? undefined : ctx.remote[namespace];
          if (service === undefined || service === null) {
            return Promise.resolve(failure(
              'gateway/invocation-unavailable',
              `the ${namespace} Remote namespace is not available`,
            ));
          }
          return invoke(service, method, request);
        },
      };
    }

    /** @returns a user-facing string for a `{ok:false,error}` payload. */
    function errorText(error, t) {
      if (error === null || error === undefined) return t('error.unknown');
      if (typeof error.message === 'string' && error.message.length > 0) return error.message;
      if (typeof error.code === 'string' && error.code.length > 0) return error.code;
      return t('error.unknown');
    }

    // ---------------------------------------------------------------------
    // Shared view helpers
    // ---------------------------------------------------------------------

    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    /** `Intl.supportedValuesOf` is absent on older engines; an empty list only
     *  costs the datalist suggestions, so free text stays the fallback. */
    const TIME_ZONES = (() => {
      try {
        if (typeof Intl.supportedValuesOf === 'function') return Intl.supportedValuesOf('timeZone');
      } catch (error) {
        // Ignore: fall through to an empty list.
      }
      return [];
    })();

    /** @returns the browser's IANA zone, or `UTC`. */
    function defaultTimeZone() {
      try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return typeof zone === 'string' && zone.length > 0 ? zone : 'UTC';
      } catch (error) {
        return 'UTC';
      }
    }

    /** @returns true when `Intl` can resolve the zone (the real IANA check). */
    function isKnownTimeZone(value) {
      const zone = String(value === null || value === undefined ? '' : value).trim();
      if (zone.length === 0) return false;
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
      } catch (error) {
        return false;
      }
    }

    /**
     * Normalize a typed time to the `HH:mm:ss` the Host accepts.
     * @returns The normalized time, or null when it is not a valid clock time.
     */
    function normalizeTime(value) {
      const text = String(value === null || value === undefined ? '' : value).trim();
      const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(text);
      if (match === null) return null;
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      const seconds = match[3] === undefined ? 0 : Number(match[3]);
      if (hours > 23 || minutes > 59 || seconds > 59) return null;
      return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
    }

    /** `07:00:00` -> `07:00`; keeps seconds only when they are meaningful. */
    function shortTime(value) {
      const match = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value === null || value === undefined ? '' : value));
      if (match === null) return String(value === null || value === undefined ? '' : value);
      return match[3] === undefined || match[3] === '00'
        ? `${match[1]}:${match[2]}`
        : `${match[1]}:${match[2]}:${match[3]}`;
    }

    /** Wall-clock date and time of an instant in one IANA zone. */
    function partsInZone(iso, timeZone) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return null;
      try {
        const dateFormat = new Intl.DateTimeFormat('en-CA', {
          timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        });
        const timeFormat = new Intl.DateTimeFormat('en-GB', {
          timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
        return { date: dateFormat.format(date), time: timeFormat.format(date) };
      } catch (error) {
        return null;
      }
    }

    /** @returns a localized date/time string for an ISO instant. */
    function formatInstant(iso) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return String(iso === null || iso === undefined ? '' : iso);
      try {
        return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
      } catch (error) {
        return date.toISOString();
      }
    }

    /** @returns a compact "how long ago" string. */
    function formatAgo(iso, t) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return String(iso === null || iso === undefined ? '' : iso);
      const seconds = Math.round((Date.now() - date.getTime()) / 1000);
      if (seconds < 45) return t('ago.justNow');
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return t('ago.minutes', { n: String(minutes) });
      const hours = Math.round(minutes / 60);
      if (hours < 24) return t('ago.hours', { n: String(hours) });
      const days = Math.round(hours / 24);
      if (days < 30) return t('ago.days', { n: String(days) });
      return formatInstant(iso);
    }

    function weekdayName(t, weekday) {
      return t(`weekday.${weekday}`);
    }

    /**
     * Human-readable summary of a STORED rule (task.schedule), not of the
     * editor draft: the record's `kind` and its own fields are authoritative.
     */
    function scheduleSummary(schedule, t) {
      if (schedule === null || schedule === undefined) return t('schedule.unknown', { kind: '?' });
      const zone = typeof schedule.timeZone === 'string' ? schedule.timeZone : '';
      const time = shortTime(schedule.time);
      switch (schedule.kind) {
        case 'daily':
          return t('schedule.daily', { time, zone });
        case 'weekly': {
          const days = Array.isArray(schedule.weekdays) ? schedule.weekdays : [];
          const isWeekdayPreset = days.length === 5
            && WEEKDAY_PRESET.every((day) => days.indexOf(day) !== -1);
          if (isWeekdayPreset) return t('schedule.weekdays', { time, zone });
          const names = days.map((day) => weekdayName(t, day)).join(', ');
          return t('schedule.weekly', { days: names, time, zone });
        }
        case 'every':
          return everySummary(Number(schedule.everySeconds), t);
        case 'cron':
          return t('schedule.cron', { expression: String(schedule.expression || ''), zone });
        case 'at':
          return t('schedule.once', { instant: formatInstant(schedule.scheduledAt) });
        case 'after':
          return t('schedule.after', { seconds: String(schedule.afterSeconds === undefined ? '' : schedule.afterSeconds) });
        default:
          return t('schedule.unknown', { kind: String(schedule.kind) });
      }
    }

    /** @returns the most natural unit for a fixed interval. */
    function everySummary(seconds, t) {
      if (Number.isFinite(seconds) && seconds > 0) {
        if (seconds % 3600 === 0) return t('schedule.everyHours', { count: String(seconds / 3600) });
        if (seconds % 60 === 0) return t('schedule.everyMinutes', { count: String(seconds / 60) });
        return t('schedule.everySeconds', { count: String(seconds) });
      }
      return t('schedule.everySeconds', { count: String(seconds) });
    }

    /** `provider / model` for a run target. */
    function modelLabel(target, t) {
      if (target === null || target === undefined) return t('model.default');
      const provider = typeof target.provider === 'string' ? target.provider : '';
      const model = typeof target.model === 'string' ? target.model : '';
      if (provider.length === 0 && model.length === 0) return t('model.default');
      return `${provider.length > 0 ? provider : t('model.default')} / ${model.length > 0 ? model : t('model.default')}`;
    }

    /**
     * The secondary line under the model: thinking level and agent preset.
     *
     * An empty target is legitimate now — the Host falls back to the plugin's
     * own settings — so it says so rather than rendering a blank cell.
     */
    /**
     * The per-task parts of the muted line under the model name.
     *
     * Returns them separately rather than a joined string, because the row also
     * appends the task's own workspace when it names one.
     *
     * @returns An array, empty when the target is entirely inherited.
     */
    function targetMetaParts(target, t) {
      if (target === null || target === undefined) return [];
      const parts = [];
      if (typeof target.effort === 'string' && target.effort.length > 0) {
        parts.push(`${t('field.effort')}: ${target.effort}`);
      }
      if (typeof target.preset === 'string' && target.preset.length > 0) {
        parts.push(`${t('field.agent')}: ${target.preset}`);
      }
      return parts;
    }

    /** @returns a single label for the last run, with its error when it failed. */
    function lastRunLabel(task, t) {
      const run = task.lastRun;
      if (run === null || run === undefined) {
        return h('span', { className: 'st-muted' }, t('lastRun.never'));
      }
      const ok = run.ok === true;
      return h('div', { className: 'st-run' },
        h('span', { className: 'st-badge', 'data-tone': ok ? 'ok' : 'error' },
          ok ? t('lastRun.ok') : t('lastRun.failed')),
        h('span', { className: 'st-muted' }, formatAgo(run.finishedAt, t)),
        ok || typeof run.error !== 'string'
          ? null
          : h('span', { className: 'st-run-error', title: run.error }, run.error),
      );
    }

    /** @returns the next-run cell contents. */
    function nextRunLabel(task, t) {
      if (task.enabled !== true) return h('span', { className: 'st-muted' }, t('nextRun.paused'));
      const at = task.schedule === undefined ? undefined : task.schedule.scheduledAt;
      if (typeof at !== 'string' || at.length === 0) {
        return h('span', { className: 'st-muted' }, t('nextRun.paused'));
      }
      return formatInstant(at);
    }

    /**
     * Normalize `agentPresets.list()`'s roster.
     *
     * Only `{presets: [...]}` was verified upstream, so this tolerates a string
     * list, an object map, and records that name themselves `id`/`key`/`name`.
     */
    function normalizePresets(value) {
      const raw = value === null || value === undefined ? undefined : value.presets;
      let list = [];
      if (Array.isArray(raw)) list = raw;
      else if (raw !== null && typeof raw === 'object') {
        list = Object.keys(raw).map((key) => ({ id: key, name: raw[key] && raw[key].name ? raw[key].name : key }));
      }
      const seen = Object.create(null);
      const result = [];
      for (const entry of list) {
        const record = typeof entry === 'string' ? { id: entry, name: entry } : entry;
        if (record === null || typeof record !== 'object') continue;
        const id = record.id !== undefined ? record.id
          : record.key !== undefined ? record.key
            : record.name;
        if (typeof id !== 'string' || id.length === 0 || seen[id] === true) continue;
        const name = record.name !== undefined ? record.name
          : record.title !== undefined ? record.title
            : record.label !== undefined ? record.label
              : id;
        seen[id] = true;
        result.push({ id, name: String(name) });
      }
      return result;
    }

    /** The thinking level a model seeds when it is picked. */
    function defaultEffortFor(models, modelId) {
      const model = models.find((candidate) => candidate.id === modelId);
      const reasoning = model === undefined || model === null ? undefined : model.reasoning;
      if (reasoning === undefined || reasoning === null) return '';
      return typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : '';
    }

    function tomorrowDate() {
      const next = new Date(Date.now() + 24 * 60 * 60 * 1000);
      return `${next.getFullYear()}-${pad2(next.getMonth() + 1)}-${pad2(next.getDate())}`;
    }

    function toggleWeekday(days, day) {
      const index = days.indexOf(day);
      if (index === -1) return days.concat([day]).sort((left, right) => left - right);
      return days.filter((value) => value !== day);
    }

    // ---------------------------------------------------------------------
    // Editor draft <-> wire shapes
    // ---------------------------------------------------------------------

    function blankDraft() {
      return {
        id: null,
        title: '',
        storedKind: 'new',
        scheduleType: 'daily',
        time: '07:00:00',
        timeZone: defaultTimeZone(),
        weekdays: WEEKDAY_PRESET.slice(),
        count: '30',
        onceDate: tomorrowDate(),
        onceTime: '09:00:00',
        cron: '0 7 * * *',
        provider: '',
        model: '',
        effort: '',
        preset: '',
        // Empty means "inherit the plugin setting", which is the default for a
        // new task and for every task stored before the field existed.
        workspaceId: '',
        prompt: '',
        enabled: true,
      };
    }

    /** Turn one stored task into an editor draft, preserving what it can. */
    function draftFromTask(task) {
      const schedule = task.schedule === undefined || task.schedule === null ? {} : task.schedule;
      const target = task.target === undefined || task.target === null ? {} : task.target;
      const zone = typeof schedule.timeZone === 'string' && schedule.timeZone.length > 0
        ? schedule.timeZone
        : defaultTimeZone();
      const days = Array.isArray(schedule.weekdays) && schedule.weekdays.length > 0
        ? schedule.weekdays.slice().sort((left, right) => left - right)
        : WEEKDAY_PRESET.slice();

      const draft = {
        id: task.id,
        title: typeof task.title === 'string' ? task.title : '',
        storedKind: typeof schedule.kind === 'string' ? schedule.kind : 'daily',
        scheduleType: 'daily',
        time: normalizeTime(schedule.time) || '07:00:00',
        timeZone: zone,
        weekdays: days,
        count: '30',
        onceDate: tomorrowDate(),
        onceTime: '09:00:00',
        cron: typeof schedule.expression === 'string' && schedule.expression.length > 0
          ? schedule.expression
          : '0 7 * * *',
        provider: typeof target.provider === 'string' ? target.provider : '',
        model: typeof target.model === 'string' ? target.model : '',
        effort: typeof target.effort === 'string' ? target.effort : '',
        preset: typeof target.preset === 'string' ? target.preset : '',
        // A task stored before this field existed carries no key at all.
        workspaceId: typeof task.workspaceId === 'string' ? task.workspaceId : '',
        prompt: typeof schedule.prompt === 'string' ? schedule.prompt : '',
        enabled: task.enabled !== false,
      };

      switch (schedule.kind) {
        case 'daily':
          draft.scheduleType = 'daily';
          break;
        case 'weekly':
          draft.scheduleType = days.length === 5 && WEEKDAY_PRESET.every((day) => days.indexOf(day) !== -1)
            ? 'weekdays'
            : 'weekly';
          break;
        case 'every': {
          const seconds = Number(schedule.everySeconds);
          if (Number.isFinite(seconds) && seconds > 0 && seconds % 3600 === 0) {
            draft.scheduleType = 'everyHours';
            draft.count = String(seconds / 3600);
          } else {
            draft.scheduleType = 'everyMinutes';
            draft.count = Number.isFinite(seconds) && seconds > 0 ? String(seconds / 60) : '30';
          }
          break;
        }
        case 'cron':
          draft.scheduleType = 'custom';
          break;
        case 'at': {
          draft.scheduleType = 'once';
          // `at` records carry no timeZone, so the stored instant is rendered in
          // the editor's zone and parses back to the same instant if untouched.
          const parts = partsInZone(schedule.scheduledAt, zone);
          if (parts !== null) {
            draft.onceDate = parts.date;
            draft.onceTime = parts.time;
          }
          break;
        }
        case 'after': {
          // There is no "delay" editor field; show it as an interval and warn.
          const seconds = Number(schedule.afterSeconds);
          draft.scheduleType = 'everyMinutes';
          draft.count = Number.isFinite(seconds) && seconds > 0 ? String(seconds / 60) : '30';
          break;
        }
        default:
          draft.scheduleType = 'daily';
          break;
      }

      return draft;
    }

    /**
     * The `rule` the Host accepts (lib/schema.js `ruleInput`).
     * Only the fields owned by the chosen kind are sent.
     */
    function buildRule(draft) {
      const zone = draft.timeZone.trim();
      switch (draft.scheduleType) {
        case 'daily':
          return { kind: 'daily', time: normalizeTime(draft.time), timeZone: zone };
        case 'weekdays':
          return { kind: 'weekly', time: normalizeTime(draft.time), timeZone: zone, weekdays: WEEKDAY_PRESET.slice() };
        case 'weekly':
          return {
            kind: 'weekly',
            time: normalizeTime(draft.time),
            timeZone: zone,
            weekdays: draft.weekdays.slice().sort((left, right) => left - right),
          };
        case 'everyMinutes':
          return { kind: 'every', everySeconds: Math.round(Number(draft.count) * 60) };
        case 'everyHours':
          return { kind: 'every', everySeconds: Math.round(Number(draft.count) * 3600) };
        case 'once':
          // The local form: `{date, time, time_zone}` (snake_case on the wire).
          return {
            kind: 'at',
            at: { date: draft.onceDate, time: normalizeTime(draft.onceTime), time_zone: zone },
          };
        case 'custom':
          return { kind: 'cron', expression: draft.cron.trim(), timeZone: zone };
        default:
          throw new Error(`unknown schedule type: ${String(draft.scheduleType)}`);
      }
    }

    /**
     * The run target. Empty strings are omitted: the Host treats an absent field
     * as "keep the stored value" (on update) or "use the plugin default".
     */
    function buildTarget(draft, reasoning) {
      const target = {};
      if (draft.provider.length > 0) target.provider = draft.provider;
      if (draft.model.length > 0) target.model = draft.model;
      if (draft.preset.length > 0) target.preset = draft.preset;
      // A model without `reasoning` exposes no effort control, so the field is
      // omitted entirely rather than sent as a value the picker cannot produce.
      if (reasoning !== undefined && draft.effort.length > 0) target.effort = draft.effort;
      return target;
    }

    /** @returns an error string, or null when the draft is submittable. */
    function validateDraft(draft, t) {
      const timed = draft.scheduleType === 'daily'
        || draft.scheduleType === 'weekdays'
        || draft.scheduleType === 'weekly';

      if (draft.prompt.trim().length === 0) return t('error.prompt');
      if (timed && normalizeTime(draft.time) === null) return t('error.time');
      if (timed && !isKnownTimeZone(draft.timeZone)) return t('error.zone');
      if (draft.scheduleType === 'weekly' && draft.weekdays.length === 0) return t('error.weekdays');
      if (draft.scheduleType === 'everyMinutes' || draft.scheduleType === 'everyHours') {
        const count = Number(draft.count);
        if (!Number.isFinite(count) || count <= 0) return t('error.interval');
      }
      if (draft.scheduleType === 'once') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.onceDate)) return t('error.date');
        if (normalizeTime(draft.onceTime) === null) return t('error.time');
        if (!isKnownTimeZone(draft.timeZone)) return t('error.zone');
      }
      if (draft.scheduleType === 'custom') {
        if (draft.cron.trim().split(/\s+/).filter((field) => field.length > 0).length !== 5) {
          return t('error.cron');
        }
        if (!isKnownTimeZone(draft.timeZone)) return t('error.zone');
      }
      return null;
    }

    // ---------------------------------------------------------------------
    // Styles — host theme tokens only
    // ---------------------------------------------------------------------

    const PAGE_CSS = `
      .st-page {
        height: 100%; min-height: 0; overflow: auto;
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
        font-family: var(--dsw-font-family);
        font-size: 14px; line-height: 1.6;
        padding: 28px clamp(24px, 4vw, 48px) 48px;
        /* A container, not the viewport: the panel is narrower than the window,
           so a media query would misjudge the space the table actually has. */
        container-type: inline-size;
      }
      .st-head {
        display: flex; align-items: flex-start; justify-content: space-between;
        gap: 16px; margin-bottom: 20px;
        /* Wrap rather than squeeze: the button keeps its own width and drops to
           its own line when the panel is too narrow to hold both. */
        flex-wrap: wrap;
      }
      .st-head > div { min-width: 0; }
      .st-head .st-btn { flex: 0 0 auto; }
      .st-heading { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; }
      .st-sub { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; }

      .st-btn {
        height: 32px; padding: 0 14px; border: none; cursor: pointer;
        border-radius: var(--dsw-radius-md);
        font: inherit; font-size: 13px; line-height: 20px;
        /* A fixed-height button must never wrap its label: a second line
           overflows the 32px box and gets clipped top and bottom. */
        white-space: nowrap;
        color: var(--dsw-alias-label-primary-foreground);
        background: var(--dsw-alias-button-primary-fill);
      }
      .st-btn:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
      .st-btn:disabled { opacity: 0.55; cursor: default; }
      .st-btn-outline {
        background: transparent; color: var(--dsw-alias-label-primary);
        border: 0.5px solid var(--dsw-alias-border-l3);
      }
      .st-btn-outline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .st-btn-danger {
        background: var(--dsw-alias-state-error-primary);
        color: var(--dsw-alias-label-primary-foreground);
      }
      .st-btn-ghost-danger {
        background: transparent; border: 0.5px solid transparent;
        color: var(--dsw-alias-state-error-primary);
      }
      .st-btn-ghost-danger:hover:not(:disabled) {
        background: var(--dsw-alias-interactive-bg-hover-danger);
      }
      .st-btn:focus-visible, .st-input:focus-visible, .st-textarea:focus-visible,
      .st-switch:focus-visible, .st-weekday:focus-visible, .st-tab:focus-visible {
        outline: var(--dsw-focus-ring-width) solid
          var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: 2px;
      }

      .st-notice {
        margin: 0 0 16px; padding: 8px 12px; font-size: 13px;
        border-radius: var(--dsw-radius-md);
        background: var(--dsw-alias-bg-layer-2);
        border: 0.5px solid var(--dsw-alias-border-l2);
      }
      .st-notice[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
      .st-notice[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }

      .st-status { color: var(--dsw-alias-label-tertiary); padding: 32px 0; text-align: center; }
      .st-status-error { color: var(--dsw-alias-state-error-primary); }

      .st-tablewrap {
        overflow: hidden;
        border: 0.5px solid var(--dsw-alias-border-l2);
        border-radius: var(--dsw-radius-lg);
        background: var(--dsw-alias-bg-layer-1);
      }
      /* Fixed layout driven by one colgroup shared by thead and tbody: a cell
         can no longer squeeze its neighbours, and the header cannot drift from
         its column. */
      .st-table { width: 100%; table-layout: fixed; border-collapse: collapse; }
      .st-col-task { width: 22%; }
      .st-col-schedule { width: 16%; }
      .st-col-model { width: 13%; }
      .st-col-state { width: 10%; }
      .st-col-last { width: 10%; }
      .st-col-next { width: 11%; }
      .st-col-actions { width: 18%; }
      .st-table th {
        text-align: left; white-space: nowrap;
        font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-tertiary);
        background: var(--dsw-alias-bg-layer-2);
        padding: 10px 12px; border-bottom: 0.5px solid var(--dsw-alias-border-l2);
      }
      .st-table td {
        padding: 10px 12px; vertical-align: top;
        border-bottom: 0.5px solid var(--dsw-alias-border-l1);
      }
      /* Every child of a cell may shrink, and clips its own text, so nothing
         can bleed into the next column. */
      .st-table td > * { min-width: 0; }
      .st-clip {
        min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .st-table tbody tr:last-child td { border-bottom: none; }
      .st-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .st-row-disabled .st-task-title { color: var(--dsw-alias-label-tertiary); }
      .st-td-actions { text-align: right; }
      .st-th-actions { text-align: right; }

      /* No -webkit-line-clamp here. That clamp needs display: -webkit-box,
         which is a legacy flex container, and the id element below is laid out
         as one of its items — so the id was shrunk to a few characters and the
         rest was cut off, identically in table and card mode. A plain block
         wraps instead, and nothing is ever clipped. */
      .st-task-title {
        font-weight: 500;
        overflow-wrap: anywhere;
      }
      .st-task-id {
        display: block;
        margin-top: 2px;
        font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
        font-size: 11px;
        line-height: 16px;              /* a real line box, clear of the title */
        color: var(--dsw-alias-label-tertiary);
        /* Deliberately unclipped: the id stays readable in full and wraps if
           the card is too narrow for it. */
        overflow-wrap: anywhere;
        white-space: normal;
      }
      .st-muted { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
      .st-stack { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .st-run { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .st-run-error {
        min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--dsw-alias-state-error-primary); font-size: 12px;
      }
      .st-badge {
        display: inline-block; padding: 1px 8px; font-size: 11px; line-height: 18px;
        border-radius: var(--dsw-radius-sm);
        background: var(--dsw-alias-bg-module-platform);
        color: var(--dsw-alias-label-secondary);
      }
      .st-badge[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
      .st-badge[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }

      .st-state { display: flex; align-items: center; gap: 8px; }
      .st-switch {
        position: relative; flex: none; width: 36px; height: 20px; padding: 0;
        border: none; cursor: pointer; border-radius: 999px;
        background: var(--dsw-alias-border-l3);
        transition: background var(--ds-transition-duration-fast, 0.15s) var(--ds-ease-in-out, ease);
      }
      .st-switch[data-checked="true"] { background: var(--dsw-alias-brand-primary); }
      .st-switch:disabled { opacity: 0.55; cursor: default; }
      .st-switch-thumb {
        position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
        border-radius: 50%;
        background: var(--dsw-alias-switch-thumb, var(--dsw-alias-label-primary-foreground));
        transition: transform var(--ds-transition-duration-fast, 0.15s) var(--ds-ease-in-out, ease);
      }
      .st-switch[data-checked="true"] .st-switch-thumb { transform: translateX(16px); }

      .st-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .st-td-actions .st-actions { justify-content: flex-end; }
      .st-td-actions .st-btn { padding: 0 10px; }
      .st-confirm { display: flex; align-items: center; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
      .st-confirm span { font-size: 12px; color: var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary)); }

      .st-editor { max-width: 760px; display: flex; flex-direction: column; gap: 16px; }
      .st-editor-title { margin: 0; font-size: 16px; font-weight: 500; }
      .st-formerror {
        margin: 0; padding: 8px 12px; font-size: 13px;
        border-radius: var(--dsw-radius-md);
        color: var(--dsw-alias-state-error-primary);
        background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-state-error-primary);
      }
      .st-field { display: flex; flex-direction: column; gap: 6px; }
      .st-field-row { flex-direction: row; align-items: center; justify-content: space-between; gap: 16px; }
      .st-label { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
      .st-hint { margin: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
      .st-hint-warn { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary)); }

      .st-input, .st-textarea {
        width: 100%; box-sizing: border-box; padding: 0 10px;
        font: inherit; font-size: 14px; outline: none;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-1);
        border: 0.5px solid var(--dsw-alias-border-l4);
        border-radius: var(--dsw-radius-md);
      }
      .st-input { height: 34px; }
      select.st-input { appearance: auto; }
      .st-input-narrow { width: 110px; flex: none; }
      .st-textarea {
        min-height: 180px; padding: 10px; line-height: 1.5;
        resize: vertical; font-family: inherit;
      }
      .st-input:focus, .st-textarea:focus { border-color: var(--dsw-alias-state-business-primary); }
      .st-input::placeholder, .st-textarea::placeholder { color: var(--dsw-alias-label-dimmed); }
      .st-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .st-inline .st-input { flex: 1 1 160px; width: auto; }

      .st-weekdays { display: flex; gap: 6px; flex-wrap: wrap; }
      .st-weekday {
        min-width: 46px; height: 30px; padding: 0 8px; cursor: pointer;
        font: inherit; font-size: 12px;
        border-radius: var(--dsw-radius-sm);
        border: 0.5px solid var(--dsw-alias-border-l3);
        background: transparent; color: var(--dsw-alias-label-secondary);
      }
      .st-weekday:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .st-weekday[data-on="true"] {
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-button-ghost-active-fill, var(--dsw-alias-interactive-bg-active));
        border-color: var(--dsw-alias-border-l4);
      }
      .st-editor-actions {
        justify-content: flex-end; padding-top: 8px;
        border-top: 0.5px solid var(--dsw-alias-border-l2);
      }

      .st-tabs {
        display: flex; gap: 4px; margin-bottom: 16px;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2);
      }
      .st-tab {
        appearance: none; border: none; background: transparent; cursor: pointer;
        margin-bottom: -0.5px; padding: 8px 12px;
        font: inherit; font-size: 13px; line-height: 20px;
        color: var(--dsw-alias-label-tertiary);
        border-bottom: 2px solid transparent;
      }
      .st-tab:hover { color: var(--dsw-alias-label-primary); }
      .st-tab[aria-selected="true"] {
        color: var(--dsw-alias-label-primary);
        border-bottom-color: var(--dsw-alias-state-business-primary);
      }
      .st-panel { min-height: 0; }
      .st-settings { max-width: 760px; display: flex; flex-direction: column; gap: 16px; }
      .st-section-title { margin: 8px 0 0; font-size: 14px; font-weight: 500; }
      .st-section-hint { margin: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); }

      /* Below this panel width seven columns cannot stay readable, so each row
         becomes a labelled card and the header goes with the columns. Keyed on
         the panel (st-page), not the viewport, because the panel is the element
         that actually runs out of room. */
      @container (max-width: 1039px) {
        .st-tablewrap {
          border: none; border-radius: 0; background: transparent; overflow: visible;
        }
        .st-table { display: block; }
        .st-table colgroup, .st-table thead { display: none; }
        .st-table tbody { display: block; }
        .st-table tr {
          display: block; margin-bottom: 10px; padding: 12px 14px;
          border: 0.5px solid var(--dsw-alias-border-l2);
          border-radius: var(--dsw-radius-lg);
          background: var(--dsw-alias-bg-layer-1);
        }
        .st-table tbody tr:last-child { margin-bottom: 0; }
        /* The hover wash belongs to a table row, not a card. */
        .st-table tbody tr:hover { background: var(--dsw-alias-bg-layer-1); }
        .st-table td {
          display: flex; align-items: baseline; gap: 10px;
          padding: 3px 0; border-bottom: none;
        }
        .st-table td::before {
          content: attr(data-label);
          flex: 0 0 78px;
          font-size: 12px; color: var(--dsw-alias-label-tertiary);
        }
        /* Cells that carry no column label. These override the td:before rule,
           so they must carry the same td qualifier to win on specificity. */
        .st-table td.st-cell-plain { display: block; }
        .st-table td.st-cell-plain::before,
        .st-table td.st-cell-actions::before { content: none; }
        .st-cell-actions { justify-content: flex-end; padding-top: 8px; }
        /* A card has room to wrap, so nothing needs truncating here. */
        .st-clip { overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; }
      }

      /* Narrower still: stack the header deliberately rather than relying on the
         wrap, so the title gets a full line and the button sits under it. */
      @container (max-width: 700px) {
        .st-head { flex-direction: column; align-items: flex-start; gap: 12px; }
      }

      @media (prefers-reduced-motion: reduce) {
        .st-switch, .st-switch-thumb { transition: none; }
      }
    `;

    // ---------------------------------------------------------------------
    // Controls (hand-rolled: Harness Client packages are off limits)
    // ---------------------------------------------------------------------

    /** A real toggle. `role="switch"` + `aria-checked` is the contract. */
    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'st-switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        'data-checked': props.checked ? 'true' : 'false',
        disabled: props.disabled === true ? true : undefined,
        onClick: () => {
          if (props.disabled === true) return;
          props.onChange(!props.checked);
        },
      }, h('span', { className: 'st-switch-thumb' }));
    }

    /** One labeled row; the label wraps a single control for a free a11y win. */
    function formField(label, control, hint, key) {
      return h('label', { className: 'st-field', key },
        h('span', { className: 'st-label' }, label),
        control,
        hint === undefined || hint === null ? null : h('p', { className: 'st-hint' }, hint),
      );
    }

    /** A labeled row for a group of controls (a label cannot wrap several). */
    function formGroup(label, control, hint, key) {
      return h('div', { className: 'st-field', key },
        h('span', { className: 'st-label' }, label),
        control,
        hint === undefined || hint === null ? null : h('p', { className: 'st-hint' }, hint),
      );
    }

    // ---------------------------------------------------------------------
    // Settings draft <-> wire shape
    // ---------------------------------------------------------------------

    function blankSettingsDraft() {
      return {
        cwd: '',
        workspaceId: '',
        provider: '',
        model: '',
        effort: '',
        preset: '',
        importFromScheduler: false,
      };
    }

    /** Turn the stored settings into an editable draft. */
    function settingsDraftFrom(settings) {
      const value = settings === null || settings === undefined ? {} : settings;
      return {
        cwd: typeof value.cwd === 'string' ? value.cwd : '',
        workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId : '',
        provider: typeof value.provider === 'string' ? value.provider : '',
        model: typeof value.model === 'string' ? value.model : '',
        effort: typeof value.effort === 'string' ? value.effort : '',
        preset: typeof value.preset === 'string' ? value.preset : '',
        importFromScheduler: value.importFromScheduler === true,
      };
    }

    /**
     * The `saveSettings` request (lib/schema.js `settingsUpdateRequest`).
     *
     * The whole target is sent so that emptying a field really clears it — the
     * Host keeps its stored value only for an *absent* field. `effort` is the
     * exception: a model with no reasoning control offers nothing to pick, so
     * the stored effort is left alone rather than cleared behind the user.
     */
    function buildSettingsRequest(draft, reasoning) {
      const request = {
        cwd: draft.cwd.trim(),
        // Sent even when empty, so choosing "None" really clears a stored
        // workspace — the Host only keeps a value for an *absent* field.
        workspaceId: draft.workspaceId,
        provider: draft.provider,
        model: draft.model,
        preset: draft.preset,
        importFromScheduler: draft.importFromScheduler,
      };
      if (reasoning !== undefined) request.effort = draft.effort;
      return request;
    }

    // ---------------------------------------------------------------------
    // The page
    // ---------------------------------------------------------------------

    /** Stable ids tying each tab to the panel it controls. */
    const TAB_IDS = Object.freeze({ tasks: 'st-tab-tasks', settings: 'st-tab-settings' });

    function ScheduledTasksPage(props) {
      const t = props.t;
      const api = props.api;
      const resetHook = props.resetHook;

      const [view, setView] = React.useState('tasks');
      const [list, setList] = React.useState({ status: 'loading', tasks: [], error: null });
      const [catalog, setCatalog] = React.useState({ status: 'loading', groups: [], error: null });
      const [presets, setPresets] = React.useState({ status: 'loading', values: [], error: null });
      const [settings, setSettings] = React.useState({ status: 'loading', value: null, error: null });
      const [workspaceList, setWorkspaceList] = React.useState([]);
      const [settingsDraft, setSettingsDraft] = React.useState(blankSettingsDraft);
      const [settingsError, setSettingsError] = React.useState(null);
      const [settingsBusy, setSettingsBusy] = React.useState(false);
      const [draft, setDraft] = React.useState(null);
      const [formError, setFormError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [pendingDelete, setPendingDelete] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      // The settings form belongs to the user: a background reload (a reconnect,
      // say) must not overwrite what they are typing.
      const settingsDirty = React.useRef(false);

      // --- loading -------------------------------------------------------

      async function loadTasks() {
        const result = await api.tasks.call('list');
        if (result.ok) {
          const tasks = result.value !== null && result.value !== undefined && Array.isArray(result.value.tasks)
            ? result.value.tasks
            : [];
          setList({ status: 'ready', tasks, error: null });
        } else {
          setList({ status: 'error', tasks: [], error: errorText(result.error, t) });
        }
      }

      async function loadCatalog() {
        const result = await api.session.call('modelCatalog');
        if (result.ok) {
          const groups = result.value !== null && result.value !== undefined && Array.isArray(result.value.groups)
            ? result.value.groups
            : [];
          setCatalog({ status: 'ready', groups, error: null });
        } else {
          setCatalog({ status: 'error', groups: [], error: errorText(result.error, t) });
        }
      }

      async function loadPresets() {
        const result = await api.presets.call('list');
        if (result.ok) {
          setPresets({ status: 'ready', values: normalizePresets(result.value), error: null });
          return;
        }
        // The roster is optional upstream: an unavailable namespace means "no
        // preset choices", not a broken page (the shipped picker does the same).
        if (result.error !== null && result.error !== undefined
            && result.error.code === 'gateway/invocation-unavailable') {
          setPresets({ status: 'ready', values: [], error: null });
          return;
        }
        setPresets({ status: 'error', values: [], error: errorText(result.error, t) });
      }

      async function loadSettings() {
        const result = await api.tasks.call('settings');
        if (!result.ok) {
          setSettings({ status: 'error', value: null, error: errorText(result.error, t) });
          return;
        }
        const value = result.value !== null && result.value !== undefined && result.value.settings
          ? result.value.settings
          : null;
        setSettings({ status: 'ready', value, error: null });
        if (!settingsDirty.current) setSettingsDraft(settingsDraftFrom(value));
      }

      /**
       * The workspace registry is optional: a Harness without one answers with
       * an unavailable namespace or an empty list, and the Settings tab then
       * shows the directory field alone — deliberately without an error banner,
       * because nothing is actually broken.
       */
      async function loadWorkspaces() {
        const result = await api.tasks.call('workspaces');
        const values = result.ok
          && result.value !== null && result.value !== undefined
          && Array.isArray(result.value.workspaces)
          ? result.value.workspaces
          : [];
        setWorkspaceList(values);
      }

      function reloadAll() {
        void loadTasks();
        void loadCatalog();
        void loadPresets();
        void loadSettings();
        void loadWorkspaces();
      }

      // Initial load. `connection/reset` re-runs these through `resetHook`.
      React.useEffect(() => {
        void loadTasks();
        void loadCatalog();
        void loadPresets();
        void loadSettings();
        void loadWorkspaces();
      }, []);

      // The listener lives in `apply`, outside React, so publish the current
      // reload entry point on every render and clear it on unmount.
      React.useEffect(() => {
        resetHook.current = reloadAll;
        return () => {
          if (resetHook.current === reloadAll) resetHook.current = null;
        };
      });

      // --- task mutations ------------------------------------------------

      async function setEnabled(task, next) {
        setNotice(null);
        setBusy(true);
        const result = await api.tasks.call('update', { id: task.id, enabled: next });
        setBusy(false);
        if (!result.ok) {
          setNotice({ tone: 'error', text: errorText(result.error, t) });
          return;
        }
        await loadTasks();
      }

      async function runTask(task) {
        setNotice(null);
        setBusy(true);
        const result = await api.tasks.call('runNow', { id: task.id });
        setBusy(false);
        if (result.ok) {
          const sessionId = result.value !== null && result.value !== undefined && result.value.sessionId
            ? result.value.sessionId
            : '';
          setNotice({ tone: 'ok', text: t('notice.started', { id: sessionId }) });
        } else {
          setNotice({ tone: 'error', text: errorText(result.error, t) });
        }
        // A failed manual run still records history, so reload either way.
        await loadTasks();
      }

      async function removeTask(id) {
        setPendingDelete(null);
        setBusy(true);
        const result = await api.tasks.call('delete', { id });
        setBusy(false);
        if (!result.ok) {
          setNotice({ tone: 'error', text: errorText(result.error, t) });
          return;
        }
        setNotice({ tone: 'ok', text: t('notice.deleted') });
        await loadTasks();
      }

      // --- settings mutation ---------------------------------------------

      function patchSettings(change) {
        settingsDirty.current = true;
        setSettingsDraft((current) => Object.assign({}, current, change));
      }

      function cancelSettings() {
        settingsDirty.current = false;
        setSettingsError(null);
        setSettingsDraft(settingsDraftFrom(settings.value));
      }

      async function saveSettings(event) {
        if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault();
        if (settingsBusy) return;
        const current = settingsDraft;
        if (current.cwd.trim().length === 0) {
          setSettingsError(t('error.cwd'));
          return;
        }
        setSettingsError(null);
        setSettingsBusy(true);
        const result = await api.tasks.call('saveSettings', buildSettingsRequest(
          current,
          reasoningOf(current.provider, current.model),
        ));
        setSettingsBusy(false);
        if (!result.ok) {
          setSettingsError(errorText(result.error, t));
          return;
        }
        const saved = result.value !== null && result.value !== undefined && result.value.settings
          ? result.value.settings
          : null;
        settingsDirty.current = false;
        setSettings({ status: 'ready', value: saved, error: null });
        setSettingsDraft(settingsDraftFrom(saved));
        setNotice({ tone: 'ok', text: t('notice.settingsSaved') });
        // The import is a one-shot flag the Host clears when it consumes it, so
        // a `false` back can mean tasks were just added: re-read the list.
        if (saved === null || saved.importFromScheduler !== true) await loadTasks();
      }

      // --- task editor ---------------------------------------------------

      function startCreate() {
        setFormError(null);
        setNotice(null);
        setDraft(blankDraft());
      }

      function startEdit(task) {
        setFormError(null);
        setNotice(null);
        setDraft(draftFromTask(task));
      }

      function cancelEdit() {
        setDraft(null);
        setFormError(null);
      }

      function patch(change) {
        setDraft((current) => (current === null ? current : Object.assign({}, current, change)));
      }

      async function save(event) {
        if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault();
        if (draft === null || busy) return;

        const problem = validateDraft(draft, t);
        if (problem !== null) {
          setFormError(problem);
          return;
        }

        const current = draft;
        const creating = current.id === null;
        setFormError(null);
        setBusy(true);

        const body = {
          title: current.title.trim(),
          prompt: current.prompt,
          rule: buildRule(current),
          target: buildTarget(current, reasoningOf(current.provider, current.model)),
          enabled: current.enabled,
          // Sent even when empty, so choosing "Inherit the plugin setting"
          // really clears a stored workspace: the Host only keeps the stored
          // value for an *absent* field.
          workspaceId: current.workspaceId,
        };
        const result = creating
          ? await api.tasks.call('create', body)
          : await api.tasks.call('update', Object.assign({ id: current.id }, body));

        setBusy(false);
        if (!result.ok) {
          setFormError(errorText(result.error, t));
          return;
        }
        setDraft(null);
        setNotice({ tone: 'ok', text: t(creating ? 'notice.created' : 'notice.saved') });
        await loadTasks();
      }

      // --- pickers, shared by the task editor and the settings form -------

      const groups = catalog.groups;

      /** @returns the catalog models of one provider, or an empty list. */
      function modelsOf(provider) {
        const group = groups.find((candidate) => candidate.id === provider);
        return group !== undefined && group !== null && Array.isArray(group.models) ? group.models : [];
      }

      /**
       * @returns the model's reasoning descriptor, or undefined when the model
       *   exposes no thinking-level control (the field is then omitted).
       */
      function reasoningOf(provider, model) {
        const found = modelsOf(provider).find((candidate) => candidate.id === model);
        if (found === undefined || found === null || found.reasoning === undefined) return undefined;
        return found.reasoning;
      }

      /**
       * Provider + model + thinking level.
       *
       * `value` is `{ provider, model, effort }` and `onPatch` merges a change
       * into whichever draft owns it, so the task editor and the settings form
       * render one identical picker. Returns an array of fields.
       */
      function modelPickerFields(value, onPatch) {
        if (catalog.status !== 'ready' || groups.length === 0) {
          // No usable catalog: free text keeps the value editable.
          return [formField(t('field.model'),
            h('div', { className: 'st-inline' },
              h('input', {
                key: 'provider', type: 'text', className: 'st-input', value: value.provider,
                placeholder: t('field.providerPlaceholder'), spellCheck: false,
                onChange: (event) => onPatch({ provider: event.target.value }),
              }),
              h('input', {
                key: 'model', type: 'text', className: 'st-input', value: value.model,
                placeholder: t('field.modelPlaceholder'), spellCheck: false,
                onChange: (event) => onPatch({ model: event.target.value }),
              })),
            catalog.status === 'error'
              ? t('catalog.unavailable', { message: catalog.error })
              : t('catalog.empty'),
            'model')];
        }

        const models = modelsOf(value.provider);
        const providerOptions = [h('option', { key: '', value: '' }, t('option.defaultProvider'))];
        for (const group of groups) {
          providerOptions.push(h('option', { key: group.id, value: group.id }, group.name || group.id));
        }
        // Keep a stored provider that is no longer in the catalog selectable.
        if (value.provider.length > 0 && !groups.some((group) => group.id === value.provider)) {
          providerOptions.push(h('option', { key: value.provider, value: value.provider }, value.provider));
        }

        const modelOptions = [h('option', { key: '', value: '' }, t('option.defaultModel'))];
        for (const model of models) {
          modelOptions.push(h('option', { key: model.id, value: model.id }, model.name || model.id));
        }
        if (value.model.length > 0 && !models.some((model) => model.id === value.model)) {
          modelOptions.push(h('option', { key: value.model, value: value.model }, value.model));
        }

        const fields = [formField(t('field.model'),
          h('div', { className: 'st-inline' },
            h('select', {
              key: 'provider', className: 'st-input', value: value.provider,
              onChange: (event) => onPatch({ provider: event.target.value, model: '', effort: '' }),
            }, providerOptions),
            h('select', {
              key: 'model', className: 'st-input', value: value.model,
              disabled: value.provider.length === 0,
              onChange: (event) => onPatch({
                model: event.target.value,
                effort: defaultEffortFor(models, event.target.value),
              }),
            }, modelOptions)),
          catalog.error === null ? null : t('catalog.stale', { message: catalog.error }),
          'model')];

        const reasoning = reasoningOf(value.provider, value.model);
        if (reasoning !== undefined) {
          const effortOptions = [h('option', { key: '', value: '' }, t('option.providerDefault'))];
          const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
          for (const effort of efforts) {
            effortOptions.push(h('option', { key: effort.id, value: effort.id }, effort.name || effort.id));
          }
          fields.push(formField(t('field.effort'),
            h('select', {
              key: 'effort', className: 'st-input', value: value.effort,
              onChange: (event) => onPatch({ effort: event.target.value }),
            }, effortOptions),
            null, 'effort'));
        }
        return fields;
      }

      /** The agent-preset picker, shared the same way. */
      function agentPickerField(value, onPatch) {
        const options = [h('option', { key: '', value: '' }, t('option.defaultAgent'))];
        for (const preset of presets.values) {
          options.push(h('option', { key: preset.id, value: preset.id }, preset.name));
        }
        if (value.preset.length > 0 && !presets.values.some((preset) => preset.id === value.preset)) {
          options.push(h('option', { key: value.preset, value: value.preset }, value.preset));
        }
        const hint = presets.status === 'error'
          ? t('presets.unavailable', { message: presets.error })
          : presets.status === 'loading'
            ? t('status.loading')
            : t('field.agentHint');
        return formField(t('field.agent'),
          h('select', {
            key: 'agent', className: 'st-input', value: value.preset,
            onChange: (event) => onPatch({ preset: event.target.value }),
          }, options), hint, 'agent');
      }

      /**
       * Workspace options, shared by the task editor and the Settings tab; only
       * the "nothing chosen" label differs between them.
       *
       * @param emptyLabel - Text for the empty choice, which means "inherit".
       * @param currentId - The value being edited.
       */
      function workspaceOptions(emptyLabel, currentId) {
        const options = [h('option', { key: '', value: '' }, emptyLabel)];
        for (const workspace of workspaceList) {
          options.push(h('option', { key: workspace.id, value: workspace.id },
            workspace.title || workspace.path || workspace.id));
        }
        // Keep a stored workspace the registry no longer lists selectable, so
        // opening the form cannot silently drop it.
        if (currentId.length > 0 && !workspaceList.some((workspace) => workspace.id === currentId)) {
          options.push(h('option', { key: currentId, value: currentId }, currentId));
        }
        return options;
      }

      /** @returns the display label for one workspace id. */
      function workspaceLabel(id) {
        const found = workspaceList.find((workspace) => workspace.id === id);
        if (found === undefined || found === null) return id;
        return found.title || found.path || found.id;
      }

      /**
       * The task's own workspace, next to Model / Thinking level / Agent.
       *
       * With no registry the field is absent rather than broken, and the draft
       * keeps whatever id the task carried, so a save cannot clear a value the
       * user was never shown.
       *
       * @returns A field element, or null when there is no registry to pick from.
       */
      function taskWorkspaceField() {
        if (workspaceList.length === 0) return null;
        return formField(t('field.workspace'), h('select', {
          key: 'task-workspace', className: 'st-input', value: draft.workspaceId,
          onChange: (event) => patch({ workspaceId: event.target.value }),
        }, workspaceOptions(t('option.inheritWorkspace'), draft.workspaceId)),
        t('field.workspaceHint'), 'task-workspace');
      }

      /**
       * The muted line under the model name.
       *
       * The workspace appears only when the task names its own and it differs
       * from the plugin default — an inherited workspace is the common case and
       * does not need repeating on every row. Suppressed until the settings are
       * loaded, so the line never claims a difference it cannot yet check.
       */
      function rowMeta(task) {
        const parts = targetMetaParts(task.target, t);
        const own = typeof task.workspaceId === 'string' ? task.workspaceId : '';
        const known = settings.status === 'ready'
          && settings.value !== null && settings.value !== undefined
          && typeof settings.value.workspaceId === 'string';
        if (own.length > 0 && known && own !== settings.value.workspaceId) {
          parts.push(`${t('field.workspace')}: ${workspaceLabel(own)}`);
        }
        return parts.length === 0 ? t('target.inherited') : parts.join(' · ');
      }

      // --- render: list --------------------------------------------------

      function renderRow(task) {
        const deleting = pendingDelete === task.id;
        const schedule = scheduleSummary(task.schedule, t);
        const model = modelLabel(task.target, t);
        const meta = rowMeta(task);
        return h('tr', {
          key: task.id,
          className: task.enabled === true ? 'st-row' : 'st-row st-row-disabled',
        },
          // `data-label` names the cell in card mode, where the header is gone.
          h('td', { className: 'st-cell-plain' },
            h('div', { className: 'st-task-title' }, task.title),
            h('div', { className: 'st-task-id', title: task.id }, task.id)),
          h('td', { 'data-label': t('col.schedule') },
            h('div', { className: 'st-clip', title: schedule }, schedule)),
          h('td', { 'data-label': t('col.target') },
            h('div', { className: 'st-stack' },
              h('div', { className: 'st-clip', title: model }, model),
              meta.length === 0
                ? null
                : h('div', { className: 'st-muted st-clip', title: meta }, meta))),
          h('td', { className: 'st-cell-plain' },
            h('div', { className: 'st-state' },
              h(Switch, {
                checked: task.enabled === true,
                label: t('aria.toggle', { title: task.title }),
                disabled: busy,
                onChange: (next) => { void setEnabled(task, next); },
              }),
              h('span', { className: 'st-muted' },
                task.enabled === true ? t('state.enabled') : t('state.disabled')))),
          h('td', { 'data-label': t('col.lastRun') }, lastRunLabel(task, t)),
          h('td', { 'data-label': t('col.nextRun') },
            h('div', { className: 'st-clip' }, nextRunLabel(task, t))),
          h('td', { className: 'st-cell-actions st-td-actions' },
            deleting
              ? h('div', { className: 'st-confirm' },
                  h('span', null, t('confirm.delete')),
                  h('button', {
                    type: 'button', className: 'st-btn st-btn-danger', disabled: busy,
                    onClick: () => { void removeTask(task.id); },
                  }, t('action.deleteConfirm')),
                  h('button', {
                    type: 'button', className: 'st-btn st-btn-outline',
                    onClick: () => setPendingDelete(null),
                  }, t('action.cancel')))
              : h('div', { className: 'st-actions' },
                  h('button', {
                    type: 'button', className: 'st-btn st-btn-outline', disabled: busy,
                    onClick: () => { void runTask(task); },
                  }, t('action.runNow')),
                  h('button', {
                    type: 'button', className: 'st-btn st-btn-outline',
                    onClick: () => startEdit(task),
                  }, t('action.edit')),
                  h('button', {
                    type: 'button', className: 'st-btn st-btn-ghost-danger',
                    onClick: () => setPendingDelete(task.id),
                  }, t('action.delete')))));
      }

      function renderList() {
        if (list.status === 'loading') {
          return h('p', { className: 'st-status' }, t('status.loading'));
        }
        if (list.status === 'error') {
          return h('p', { className: 'st-status st-status-error' }, list.error);
        }
        if (list.tasks.length === 0) {
          return h('p', { className: 'st-status' }, t('list.empty'));
        }
        return h('div', { className: 'st-tablewrap' },
          h('table', { className: 'st-table' },
            // One colgroup drives both header and body: the two cannot drift.
            h('colgroup', null,
              h('col', { key: 'task', className: 'st-col-task' }),
              h('col', { key: 'schedule', className: 'st-col-schedule' }),
              h('col', { key: 'model', className: 'st-col-model' }),
              h('col', { key: 'state', className: 'st-col-state' }),
              h('col', { key: 'last', className: 'st-col-last' }),
              h('col', { key: 'next', className: 'st-col-next' }),
              h('col', { key: 'actions', className: 'st-col-actions' })),
            h('thead', null, h('tr', null,
              h('th', null, t('col.task')),
              h('th', null, t('col.schedule')),
              h('th', null, t('col.target')),
              h('th', null, t('col.state')),
              h('th', null, t('col.lastRun')),
              h('th', null, t('col.nextRun')),
              h('th', { className: 'st-th-actions' }, t('col.actions')))),
            h('tbody', null, list.tasks.map((task) => renderRow(task)))));
      }

      // --- render: task editor fields ------------------------------------

      function timeField() {
        return formField(t('field.time'), h('input', {
          key: 'time', type: 'text', className: 'st-input', value: draft.time,
          placeholder: t('placeholder.time'), spellCheck: false,
          onChange: (event) => patch({ time: event.target.value }),
        }), t('field.timeHint'), 'time');
      }

      function weekdayField() {
        return formGroup(t('field.weekdays'),
          h('div', { className: 'st-weekdays', role: 'group', 'aria-label': t('field.weekdays') },
            WEEKDAY_IDS.map((day) => {
              const on = draft.weekdays.indexOf(day) !== -1;
              return h('button', {
                key: String(day), type: 'button', className: 'st-weekday',
                'data-on': on ? 'true' : 'false', 'aria-pressed': on ? 'true' : 'false',
                onClick: () => patch({ weekdays: toggleWeekday(draft.weekdays, day) }),
              }, weekdayName(t, day));
            })), null, 'weekdays');
      }

      function intervalField() {
        const unit = draft.scheduleType === 'everyHours' ? t('unit.hours') : t('unit.minutes');
        return formField(t('field.interval'),
          h('div', { className: 'st-inline' },
            h('input', {
              key: 'count', type: 'text', className: 'st-input st-input-narrow', value: draft.count,
              inputMode: 'decimal', spellCheck: false,
              onChange: (event) => patch({ count: event.target.value }),
            }),
            h('span', { key: 'unit', className: 'st-muted' }, unit)), null, 'interval');
      }

      function onceFields() {
        return [
          formField(t('field.onceDate'), h('input', {
            key: 'date', type: 'text', className: 'st-input', value: draft.onceDate,
            placeholder: t('placeholder.date'), spellCheck: false,
            onChange: (event) => patch({ onceDate: event.target.value }),
          }), t('field.onceDateHint'), 'once-date'),
          formField(t('field.onceTime'), h('input', {
            key: 'time', type: 'text', className: 'st-input', value: draft.onceTime,
            placeholder: t('placeholder.time'), spellCheck: false,
            onChange: (event) => patch({ onceTime: event.target.value }),
          }), t('field.timeHint'), 'once-time'),
        ];
      }

      function cronField() {
        return formField(t('field.cron'), h('input', {
          key: 'cron', type: 'text', className: 'st-input', value: draft.cron,
          placeholder: t('placeholder.cron'), spellCheck: false,
          onChange: (event) => patch({ cron: event.target.value }),
        }), t('field.cronHint'), 'cron');
      }

      function timezoneField() {
        return formField(t('field.timezone'),
          h(React.Fragment, null,
            h('input', {
              key: 'zone', type: 'text', className: 'st-input', value: draft.timeZone,
              list: TIME_ZONES.length > 0 ? TIMEZONE_LIST_ID : undefined,
              placeholder: t('placeholder.zone'), spellCheck: false,
              onChange: (event) => patch({ timeZone: event.target.value }),
            }),
            TIME_ZONES.length > 0
              ? h('datalist', { key: 'zones', id: TIMEZONE_LIST_ID },
                  TIME_ZONES.map((zone) => h('option', { key: zone, value: zone })))
              : null),
          t('field.timezoneHint'), 'timezone');
      }

      function enabledField() {
        return h('div', { key: 'enabled', className: 'st-field st-field-row' },
          h('div', null,
            h('span', { className: 'st-label' }, t('field.enabled')),
            h('p', { className: 'st-hint' }, t('field.enabledHint'))),
          h(Switch, {
            key: 'switch',
            checked: draft.enabled,
            label: t('field.enabled'),
            onChange: (next) => patch({ enabled: next }),
          }));
      }

      function renderEditor() {
        const children = [
          h('h2', { key: 'title', className: 'st-editor-title' },
            draft.id === null ? t('editor.create') : t('editor.edit')),
        ];
        if (draft.storedKind === 'after') {
          children.push(h('p', { key: 'convert', className: 'st-hint st-hint-warn' }, t('editor.convertAfter')));
        }
        if (formError !== null) {
          children.push(h('p', { key: 'error', className: 'st-formerror', role: 'alert' }, formError));
        }

        children.push(formField(t('field.name'), h('input', {
          key: 'name', type: 'text', className: 'st-input', value: draft.title,
          spellCheck: true, onChange: (event) => patch({ title: event.target.value }),
        }), t('field.nameHint'), 'name'));

        const typeOptions = [
          ['daily', 'type.daily'],
          ['weekdays', 'type.weekdays'],
          ['weekly', 'type.weekly'],
          ['everyMinutes', 'type.everyMinutes'],
          ['everyHours', 'type.everyHours'],
          ['once', 'type.once'],
          ['custom', 'type.custom'],
        ].map(([value, key]) => h('option', { key: value, value }, t(key)));

        children.push(formField(t('field.scheduleType'), h('select', {
          key: 'type', className: 'st-input', value: draft.scheduleType,
          onChange: (event) => patch({ scheduleType: event.target.value }),
        }, typeOptions), t(`typeHint.${draft.scheduleType}`), 'type'));

        if (draft.scheduleType === 'daily'
            || draft.scheduleType === 'weekdays'
            || draft.scheduleType === 'weekly') {
          children.push(timeField());
        }
        if (draft.scheduleType === 'weekly') children.push(weekdayField());
        if (draft.scheduleType === 'everyMinutes' || draft.scheduleType === 'everyHours') {
          children.push(intervalField());
        }
        if (draft.scheduleType === 'once') children.push(...onceFields());
        if (draft.scheduleType === 'custom') children.push(cronField());
        if (draft.scheduleType !== 'everyMinutes' && draft.scheduleType !== 'everyHours') {
          children.push(timezoneField());
        }

        const workspaceField = taskWorkspaceField();
        if (workspaceField !== null) children.push(workspaceField);
        children.push(...modelPickerFields(draft, patch));
        children.push(agentPickerField(draft, patch));

        children.push(formField(t('field.prompt'), h('textarea', {
          key: 'prompt', className: 'st-textarea', value: draft.prompt,
          rows: 10, spellCheck: true,
          onChange: (event) => patch({ prompt: event.target.value }),
        }), t('field.promptHint'), 'prompt'));

        children.push(enabledField());

        children.push(h('div', { key: 'actions', className: 'st-actions st-editor-actions' },
          h('button', {
            type: 'button', className: 'st-btn st-btn-outline', disabled: busy, onClick: cancelEdit,
          }, t('action.cancel')),
          h('button', {
            type: 'submit', className: 'st-btn', disabled: busy,
          }, busy ? t('action.saving') : t('action.save'))));

        return h('form', {
          className: 'st-editor',
          onSubmit: (event) => { void save(event); },
        }, children);
      }

      // --- render: settings ----------------------------------------------

      function renderSettings() {
        if (settings.status === 'loading') {
          return h('p', { className: 'st-status' }, t('status.loading'));
        }
        const value = settingsDraft;
        const children = [
          h('h2', { key: 'title', className: 'st-editor-title' }, t('settings.title')),
          h('p', { key: 'subtitle', className: 'st-hint' }, t('settings.subtitle')),
        ];
        if (settings.status === 'error') {
          children.push(h('p', { key: 'loaderror', className: 'st-formerror', role: 'alert' },
            t('settings.unavailable')));
        }
        if (settingsError !== null) {
          children.push(h('p', { key: 'error', className: 'st-formerror', role: 'alert' }, settingsError));
        }

        if (workspaceList.length > 0) {
          children.push(formField(t('settings.workspace'), h('select', {
            key: 'workspace', className: 'st-input', value: value.workspaceId,
            onChange: (event) => patchSettings({ workspaceId: event.target.value }),
          }, workspaceOptions(t('option.noWorkspace'), value.workspaceId)),
          t('settings.workspaceHint'), 'workspace'));
        }
        // With no registry the control is absent and `workspaceId` stays as
        // loaded, so saving leaves whatever is stored alone rather than
        // clearing a value the user was never shown.
        children.push(formField(t('settings.cwd'), h('input', {
          key: 'cwd', type: 'text', className: 'st-input', value: value.cwd,
          placeholder: t('placeholder.cwd'), spellCheck: false,
          onChange: (event) => patchSettings({ cwd: event.target.value }),
        }), t('settings.cwdHint'), 'cwd'));

        children.push(h('h3', { key: 'defaults', className: 'st-section-title' }, t('settings.defaults')));
        children.push(h('p', { key: 'defaults-hint', className: 'st-section-hint' }, t('settings.defaultsHint')));
        children.push(...modelPickerFields(value, patchSettings));
        children.push(agentPickerField(value, patchSettings));

        children.push(h('div', { key: 'import', className: 'st-field st-field-row' },
          h('div', null,
            h('span', { className: 'st-label' }, t('settings.import')),
            h('p', { className: 'st-hint' }, t('settings.importHint'))),
          h(Switch, {
            key: 'switch',
            checked: value.importFromScheduler,
            label: t('settings.import'),
            disabled: settingsBusy,
            onChange: (next) => patchSettings({ importFromScheduler: next }),
          })));

        children.push(h('div', { key: 'actions', className: 'st-actions st-editor-actions' },
          h('button', {
            key: 'cancel', type: 'button', className: 'st-btn st-btn-outline',
            disabled: settingsBusy, onClick: cancelSettings,
          }, t('action.cancel')),
          h('button', {
            key: 'save', type: 'submit', className: 'st-btn', disabled: settingsBusy,
          }, settingsBusy ? t('action.saving') : t('action.saveSettings'))));

        return h('form', {
          className: 'st-settings',
          onSubmit: (event) => { void saveSettings(event); },
        }, children);
      }

      // --- render: tabs and page -----------------------------------------

      function tabButton(id, label) {
        return h('button', {
          key: id, id: TAB_IDS[id], type: 'button', role: 'tab', className: 'st-tab',
          'aria-selected': view === id ? 'true' : 'false',
          'aria-controls': `${TAB_IDS[id]}-panel`,
          onClick: () => { setView(id); setNotice(null); },
        }, label);
      }

      function renderTabs() {
        return h('div', { className: 'st-tabs', role: 'tablist', 'aria-label': t('tabs.aria') },
          tabButton('tasks', t('tab.tasks')),
          tabButton('settings', t('tab.settings')));
      }

      function renderPanel() {
        if (view === 'settings') return renderSettings();
        return draft === null ? renderList() : renderEditor();
      }

      return h('div', { className: 'st-page' },
        h('style', null, PAGE_CSS),
        h('header', { className: 'st-head' },
          h('div', null,
            h('h1', { className: 'st-heading' }, t('page.title')),
            h('p', { className: 'st-sub' }, t('page.subtitle'))),
          view === 'tasks' && draft === null
            ? h('button', { type: 'button', className: 'st-btn', onClick: startCreate }, t('action.new'))
            : null),
        notice === null
          ? null
          : h('p', { className: 'st-notice', 'data-tone': notice.tone, role: 'status' }, notice.text),
        renderTabs(),
        h('div', {
          className: 'st-panel',
          role: 'tabpanel',
          id: `${TAB_IDS[view]}-panel`,
          'aria-labelledby': TAB_IDS[view],
        }, renderPanel()));
    }

    /** The sidebar entry: an icon only — the host draws the row and the label. */
    function ScheduledTasksIcon() {
      return h('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
        h('rect', { x: 3, y: 4.5, width: 18, height: 16, rx: 3 }),
        h('path', { d: 'M3 9.5h18' }),
        h('path', { d: 'M8 3v3M16 3v3' }),
        h('path', { d: 'M12 13v2.5l2 1.5' }),
      );
    }

    // ---------------------------------------------------------------------
    // Plugin body
    // ---------------------------------------------------------------------

    /**
     * Service keys this plugin waits for.
     *
     * `remote.scheduledTasks` is deliberately absent: the namespace does not
     * exist until `$mount` runs inside `apply`, so declaring it here would keep
     * the plugin permanently inactive.
     */
    // `remote.session` and `remote.agentPresets` are shipped namespaces that
    // exist on their own, so they are declared here: reading an undeclared
    // service off the context throws. `remote.scheduledTasks` is deliberately
    // absent — it does not exist until this plugin's own `$mount` has run.
    const inject = ['slots', 'locale', 'remote', 'remote.session', 'remote.agentPresets'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en }), 'scheduled-tasks: dictionaries');
      const t = ctx.locale.bind(NS);

      // Mount our Remote namespace once per root Context, then keep the lease
      // for exactly as long as this activation lives.
      const lease = acquireMount(ctx);
      const api = {
        tasks: tasksCaller(lease),
        session: shippedCaller(ctx, 'session'),
        presets: shippedCaller(ctx, 'agentPresets'),
      };

      // The reconnect hook lives outside React; the page publishes its reload
      // entry point into this ref so a reset refreshes whatever is on screen.
      const resetHook = { current: null };
      ctx.effect(() => ctx.on('connection/reset', () => {
        if (resetHook.current !== null) resetHook.current();
      }), 'scheduled-tasks: connection reset');

      // `main` is keyed: the option is `key`, and it must equal the sidebar
      // entry's `id` below.
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ t, api, resetHook }),
      }, ScheduledTasksPage)), 'scheduled-tasks: main panel');

      // `sidebar.panellist` is a list slot: the option is `id`. The host renders
      // the row, the selected state and the click — no handler here.
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 10,
        locale: NS,
        label: () => t('panel'),
      }, ScheduledTasksIcon)), 'scheduled-tasks: sidebar entry');

      ctx.effect(() => () => lease.release(), 'scheduled-tasks: remote mount');
    }

    return { inject, apply };
  },
});
