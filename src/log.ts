/**
 * The one place amplifier writes operational output.
 *
 * Render captures a Workflow's stdout and stderr, so the console is the log
 * sink in production and the text is written verbatim. Call sites go through
 * these functions rather than `console`, which is what the `no-console`
 * ESLint rule enforces, so adding levels or JSON later means editing this file
 * alone.
 */

/** Write one line to stdout. */
export function info(message: string): void {
  console.log(message);
}

/** Write one line to stderr for something recoverable. */
export function warn(message: string): void {
  console.warn(message);
}

/**
 * Write one line to stderr, with the value that caused it when there is one.
 *
 * `cause` is passed through as a second argument so a thrown Error keeps its
 * stack, which `String(err)` would drop.
 */
export function error(message: string, cause?: unknown): void {
  if (cause === undefined) {
    console.error(message);
    return;
  }
  console.error(message, cause);
}
