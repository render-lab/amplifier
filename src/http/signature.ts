import { timingSafeEqual } from "node:crypto";
import * as log from "../log.js";

/** Constant-time compare of two strings of any length. */
export function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Whether a signed request's timestamp is recent enough to act on.
 *
 * Both Typefully and Slack sign a timestamp without expiring it, so without a
 * window a captured delivery stays valid forever. Rejects on both sides of the
 * window, so a clock far ahead fails the same way one far behind does. The
 * caller names the provider, because the two use different windows and a
 * rejection has to say which one rejected.
 */
export function isFresh(
  provider: string,
  timestamp: string,
  nowMs: number,
  toleranceMs: number,
): boolean {
  if (!/^\d+$/.test(timestamp)) {
    log.error(
      `[amplifier] Rejected a ${provider} request: timestamp ${timestamp} is not Unix seconds.`,
    );
    return false;
  }
  const skewMs = Math.abs(nowMs - Number(timestamp) * 1_000);
  if (skewMs > toleranceMs) {
    log.error(
      `[amplifier] Rejected a ${provider} request: timestamp ${timestamp} is ` +
        `${Math.round(skewMs / 60_000)} minutes from this clock, past the ` +
        `${toleranceMs / 60_000}-minute window.`,
    );
    return false;
  }
  return true;
}
