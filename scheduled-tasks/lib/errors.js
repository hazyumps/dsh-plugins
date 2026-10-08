/**
 * The plugin's error vocabulary.
 *
 * The Typert gateway recognises a thrown value by `isDSHRemoteError` and a
 * string `code`; carrying that marker here keeps the code on the wire without
 * importing the protocol package, which a profile plugin cannot resolve.
 *
 * @module dsh-plugin-scheduled-tasks/errors
 */

/** A refused request, with a stable machine-readable reason. */
export class TaskError extends Error {
  /**
   * @param code - Stable reason, e.g. `invalid_rule`.
   * @param message - Human-readable explanation shown by the editor.
   * @param details - Optional structured context.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
    this.details = details;
    // Read by the gateway to fold this into a wire failure.
    this.isDSHRemoteError = true;
  }
}

/**
 * Wrap an unknown thrown value as a wire error.
 * @param error - The thrown value.
 * @returns A `TaskError` carrying whatever reason the original had.
 */
export function asTaskError(error) {
  if (error instanceof TaskError) return error;
  const code = typeof error?.code === 'string' && error.code.length > 0
    ? `scheduled-tasks/${error.code.replace(/^scheduled-tasks\//u, '')}`
    : 'scheduled-tasks/failed';
  const message = error instanceof Error ? error.message : String(error);
  return new TaskError(code, message);
}
