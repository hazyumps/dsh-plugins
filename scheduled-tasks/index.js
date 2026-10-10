/**
 * Scheduled tasks — the Host half.
 *
 * Owns a durable task list, arms one timer, and starts a fresh session per run
 * with the task's own model, thinking level, and agent preset. The list is
 * reachable from the Web editor and, over the same service, from anything that
 * can call `ctx.scheduledTasks`.
 *
 * Everything here is self-contained: a profile-installed plugin cannot resolve
 * `@deepseek-ai/*` packages at runtime, so this bundle imports only Node
 * built-ins, `zod`, and its own modules.
 *
 * @module dsh-plugin-scheduled-tasks
 */

import { importLegacyTasks } from './lib/import.js';
import { createRunner } from './lib/runner.js';
import { createScheduler } from './lib/scheduler.js';
import { createService } from './lib/service.js';
import { createStore, harnessHome, storeFile } from './lib/store.js';

/** Cordis service key, Remote namespace, and plugin name. */
export const name = 'scheduledTasks';

/**
 * Host services this plugin needs. `sessionController` is mounted by the Web
 * application rather than the base bundle, so a profile without Web session
 * control leaves this plugin inactive instead of failing to load.
 */
export const inject = ['sessionController', 'agentDefaultModel', 'workspaceRegistry'];

/**
 * Mount the plugin.
 * @param ctx - Host context.
 */
export function apply(ctx) {
  const logger = ctx.logger;
  const store = createStore({ file: storeFile(), logger });

  // Read at the moment of use, so a settings change applies to the next run
  // rather than the next reload.
  const settings = () => store.settings();

  /**
   * Whether a workspace id still names a registered workspace.
   * @param id - Candidate workspace id.
   * @returns True when the registry knows it.
   */
  function known(id) {
    return id !== '' && ctx.workspaceRegistry.get(id) !== undefined;
  }

  /**
   * Which workspace owns a directory, when one does.
   * @param directory - An existing directory path.
   * @returns The workspace id, or undefined.
   */
  async function ownerOf(directory) {
    try {
      const owner = await ctx.workspaceRegistry.resolveByPath(directory);
      return owner === undefined ? undefined : owner.id;
    } catch {
      // The directory does not exist; the plain cwd placement still works.
      return undefined;
    }
  }

  /**
   * Place a run's session.
   *
   * A workspace attaches the session to that project, so the sidebar groups it
   * there instead of listing it as ungrouped. The task's own choice wins, then
   * its directory, then the plugin defaults — and a default directory that a
   * workspace already owns resolves to that workspace, so a run lands in the
   * right project without anyone choosing. A stale id or an unknown directory
   * falls back to the plain directory rather than failing the run.
   * @param job - The task being run.
   * @param current - The current plugin settings.
   * @returns The placement `sessionController.create` accepts.
   */
  async function placement(job, current) {
    if (known(job.workspaceId)) return { workspaceId: job.workspaceId };
    if (job.cwd !== undefined) return { cwd: job.cwd };
    if (known(current.workspaceId)) return { workspaceId: current.workspaceId };
    const owner = await ownerOf(current.cwd);
    if (owner !== undefined) return { workspaceId: owner };
    return { cwd: current.cwd };
  }

  const run = createRunner({
    sessionController: ctx.sessionController,
    agentDefaultModel: ctx.agentDefaultModel,
    settings,
    placement,
    logger,
  });

  // The scheduler is built before the service so a task created while the Host
  // runs takes effect without a reload.
  const scheduler = createScheduler({
    store: {
      list: async () => store.entries(),
      put: async (job) => {
        store.put(job.id, job);
      },
    },
    run,
    onError: (job, error) => {
      logger?.warn?.(`scheduled-tasks: "${job.title}" failed to start: ${String(error)}`);
    },
  });

  const service = createService({
    store,
    defaults: () => {
      const current = settings();
      return {
        target: {
          provider: current.provider,
          model: current.model,
          effort: current.effort,
          preset: current.preset,
        },
      };
    },
    run,
    workspaces: () => ctx.workspaceRegistry.list().map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
    })),
    onChanged: () => scheduler.rearm(),
    logger,
  });
  // The exact visible protocol binding; strict reflection is contributed
  // separately by ./typert, with no decorator or source discovery.
  service.typertRemote = Object.freeze({ service, serviceKey: name, namespace: name });
  ctx.provide(name, service);

  /**
   * Carry the shipped scheduler's tasks across once, when asked.
   * @returns The number of tasks imported.
   */
  async function migrate() {
    if (!settings().importFromScheduler) return 0;
    const imported = await importLegacyTasks({
      home: harnessHome(),
      store,
      create: (request) => service.create(request),
      logger,
    });
    // The flag is a one-shot: clear it so a later start cannot import twice.
    store.saveSettings({ ...settings(), importFromScheduler: false });
    if (imported > 0) {
      logger?.info?.(`scheduled-tasks: imported ${imported} task(s) from the shipped scheduler`);
    }
    return imported;
  }

  void migrate()
    .catch((error) => {
      logger?.error?.(`scheduled-tasks: import failed: ${String(error)}`);
    })
    .then(() => scheduler.start())
    .catch((error) => {
      logger?.error?.(`scheduled-tasks: failed to start: ${String(error)}`);
    });

  ctx.effect(() => () => {
    scheduler.stop();
  }, 'scheduled-tasks');
}
