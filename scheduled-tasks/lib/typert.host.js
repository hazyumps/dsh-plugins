/**
 * Strict Host reflection for the `scheduledTasks` namespace.
 *
 * `@deepseek-ai/dsh-typert-loader` finds this through the package's `./typert`
 * export and registers it when the plugin row mounts.
 *
 * @module dsh-plugin-scheduled-tasks/typert
 */

import {
  createRequest,
  listResult,
  settingsResult,
  settingsUpdateRequest,
  deleteRequest,
  deleteResult,
  runNowRequest,
  runNowResult,
  taskResult,
  updateRequest,
  workspaceListResult,
} from './schema.js';
import { PACKAGE, descriptors } from './contract.js';

/** Zod schema per short type symbol, for the codecs the gateway validates with. */
const SCHEMAS = {
  TaskListResult: listResult,
  TaskCreateRequest: createRequest,
  TaskResult: taskResult,
  TaskUpdateRequest: updateRequest,
  TaskDeleteRequest: deleteRequest,
  TaskDeleteResult: deleteResult,
  TaskRunRequest: runNowRequest,
  TaskRunResult: runNowResult,
  SettingsResult: settingsResult,
  SettingsUpdateRequest: settingsUpdateRequest,
  WorkspaceListResult: workspaceListResult,
};

/**
 * Resolve one codec's schema.
 * @param typeSymbol - The declared type symbol, `<package>#<ShortName>`.
 * @returns A thunk returning the zod schema.
 */
function schemaFor(typeSymbol) {
  const short = typeSymbol.slice(typeSymbol.lastIndexOf('#') + 1);
  const schema = SCHEMAS[short];
  if (schema === undefined) throw new Error(`no schema declared for ${typeSymbol}`);
  return () => schema;
}

/** The Host face of this plugin's Remote contribution. */
export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: descriptors(schemaFor),
  model: {
    services: [{
      key: 'scheduledTasks',
      exportName: 'ScheduledTasksService',
      description: 'Scheduled tasks that start a new session with a chosen model, thinking level, and agent preset.',
      summary: 'Scheduled tasks',
      tags: [],
      members: [
        { kind: 'method', name: 'list', signature: 'list(): TaskListResult' },
        { kind: 'method', name: 'settings', signature: 'settings(): SettingsResult' },
        { kind: 'method', name: 'saveSettings', signature: 'saveSettings(request: SettingsUpdateRequest): SettingsResult' },
        { kind: 'method', name: 'workspaces', signature: 'workspaces(): WorkspaceListResult' },
        { kind: 'method', name: 'create', signature: 'create(request: TaskCreateRequest): TaskResult' },
        { kind: 'method', name: 'update', signature: 'update(request: TaskUpdateRequest): TaskResult' },
        { kind: 'method', name: 'delete', signature: 'delete(request: TaskDeleteRequest): TaskDeleteResult' },
        { kind: 'method', name: 'runNow', signature: 'runNow(request: TaskRunRequest): TaskRunResult' },
      ],
      types: [],
    }],
    events: [],
    objects: [],
  },
};

export default TYPERT;
