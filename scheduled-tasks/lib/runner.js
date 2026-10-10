/**
 * Starting one run: a new session, its model, and the prompt.
 *
 * The session is created through the shipped Web session controller, so the
 * run behaves like a session the user opened by hand: it gets a persisted
 * session, the task's agent preset, and a durable prompt. It does not wait for
 * the turn to finish — a daily brief can take minutes, and the scheduler must
 * stay free to arm the next target.
 *
 * @module dsh-plugin-scheduled-tasks/runner
 */

import { randomUUID } from 'node:crypto';

/**
 * Build the run function the scheduler calls.
 * @param options - Host services.
 * @param options.sessionController - `ctx.sessionController`.
 * @param options.agentDefaultModel - `ctx.agentDefaultModel`.
 * @param options.settings - `() => { cwd, workspaceId }`, read when a run
 *   starts so a settings change applies to the next run rather than the next
 *   reload.
 * @param options.placement - `async (job, settings) => { workspaceId } | { cwd }`,
 *   the session's placement. A workspace attaches the session to that project,
 *   so it is grouped in the sidebar instead of landing ungrouped.
 * @param options.logger - Host logger.
 * @returns `(job) => Promise<string>` resolving with the started session id.
 */
export function createRunner(options) {
  const { sessionController, agentDefaultModel, settings, placement, logger } = options;

  return async function run(job) {
    const { target, schedule, title } = job;
    const { sessionId } = await sessionController.create({
      ...(await placement(job, settings())),
      ...(target.preset === '' ? {} : { agentPreset: target.preset }),
    });

    await nameSession(sessionId, title);

    if (target.provider !== '' && target.model !== '') {
      await selectModel(sessionId, target);
    }

    // `prompt` reads `signal.throwIfAborted()` synchronously. A Client caller
    // gets one from the gateway; an in-process caller must supply it, or the
    // call throws on `undefined`. A run is not cancelled from here, so the
    // signal is never aborted.
    const abort = new AbortController();
    await sessionController.prompt({
      // `prompt` treats the id as a dedupe key: reusing one silently accepts
      // without running anything, so every fire needs its own.
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: schedule.prompt }],
      ...(timeZoneOf(schedule) === undefined ? {} : { clientTimeZone: timeZoneOf(schedule) }),
    }, abort.signal);

    return sessionId;
  };

  /**
   * Label the run after its task, so the session list reads as a log of runs.
   * @param sessionId - The started session.
   * @param title - The task title.
   */
  async function nameSession(sessionId, title) {
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      await sessionController.rename({ sessionId, title: `${title} — ${stamp}` });
    } catch (error) {
      // A missing or rejected title must not stop the run.
      logger?.warn?.(`scheduled-tasks: could not name session ${sessionId}: ${String(error)}`);
    }
  }

  /**
   * Install the task's model and thinking level for the run's next request.
   *
   * `selectModel` is the shipped way to do this, and it also saves the
   * selection as the user's default model. A background task must not silently
   * change which model the user's next session opens with, so the previous
   * default is written back straight away. The run is unaffected: the pending
   * selection is installed on the session, not read from the default.
   * @param sessionId - The started session.
   * @param target - The task's normalized run target.
   */
  async function selectModel(sessionId, target) {
    const previous = agentDefaultModel.currentSelection();
    await sessionController.selectModel({
      sessionId,
      provider: target.provider,
      model: target.model,
      ...(target.effort === '' ? {} : { reasoningEffort: target.effort }),
    });
    await agentDefaultModel.saveSelection(previous);
  }
}

/**
 * Read the wall-clock zone a rule is stored in, when it has one.
 * @param schedule - A shipped `ScheduleRecord`.
 * @returns The IANA zone, or undefined for a zone-free rule.
 */
function timeZoneOf(schedule) {
  return typeof schedule.timeZone === 'string' && schedule.timeZone.length > 0
    ? schedule.timeZone
    : undefined;
}
