import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { get as kvGet, set as kvSet } from "@render-lab/tasks-render-kv";
import { loadConfig } from "../config.js";
import { postNote } from "../slack/postNote.js";
import { renderReminder } from "./remindTemplate.js";
import { remindedKey, repostedKey } from "./reposted.js";
import { REMIND_RETRY, REMIND_TIMEOUT_SECONDS } from "./retry.js";
import * as log from "../log.js";

export interface RemindRepostInput {
  /** Channel the note is in, as the id Slack echoed back when it was posted. */
  channel: string;
  /** The note's parent `ts`. */
  messageTs: string;
  /** Epoch milliseconds the check is due at. */
  dueAtMs: number;
  /**
   * Key Value key of the stored note. The reminder's Repost button carries it,
   * and both markers are built from it.
   */
  noteKey: string;
}

/** Why a run posted no reminder. */
export type RemindRefusal = "reposted" | "already-reminded" | "no-repost-channel";

export interface RemindRepostResult {
  reminded: boolean;
  reason?: RemindRefusal;
}

export interface RemindRepostDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Raw implementation of amplifier.remindRepost.
 *
 * The delay is a sleep. `RunSubtaskRequest` in `@renderinc/sdk` 1.0.0 has no
 * delay field and a started run begins at once, so nothing schedules the check
 * for later.
 *
 * `dueAtMs` is an instant rather than a duration, so an attempt that follows a
 * crash waits out what is left instead of starting the delay over. The reminded
 * marker is written before the post, so two runs for one note produce one
 * reminder.
 */
export async function remindRepostImpl(
  ctx: TaskContext,
  input: RemindRepostInput,
  env: NodeJS.ProcessEnv = process.env,
  deps: RemindRepostDeps = {},
): Promise<RemindRepostResult> {
  const config = loadConfig({}, env);
  // The reminder names the repost channel and asks for the button in it, so
  // without one there is nothing to ask for.
  if (!config.repostChannel) {
    log.info("[amplifier] No reminder: AMPLIFIER_REPOST_CHANNEL is unset.");
    return { reminded: false, reason: "no-repost-channel" };
  }

  const message = renderReminder({
    channel: input.channel,
    threadTs: input.messageTs,
    text: config.reminderText,
    repostChannel: config.repostChannel,
    noteKey: input.noteKey,
  });

  // Checked before the sleep, so a dry run answers now instead of holding the
  // run open for the whole delay to print one line.
  if (config.dryRun) {
    log.info(`[dry run] would remind:\n${message.text}`);
    return { reminded: false };
  }

  const now = deps.now ?? (() => Date.now());
  await (deps.sleep ?? wait)(Math.max(0, input.dueAtMs - now()));

  const reposted = await ctx.run(kvGet, { key: repostedKey(input.noteKey) });
  if (reposted.value !== null) return { reminded: false, reason: "reposted" };

  const key = remindedKey(input.noteKey);
  const reminded = await ctx.run(kvGet, { key });
  if (reminded.value !== null) return { reminded: false, reason: "already-reminded" };

  await ctx.run(kvSet, { key, value: "reminded", ttlSeconds: config.seenTtlSeconds });
  await ctx.run(postNote, message);
  return { reminded: true };
}

/**
 * Remind the channel when a note has not been reposted.
 *
 * `timeoutSeconds` covers the sleep, which is the whole delay, plus the two Key
 * Value reads and the post that follow it. `loadConfig` caps
 * AMPLIFIER_REMINDER_MINUTES against the same number.
 */
export const remindRepost = task(
  {
    name: "amplifier.remindRepost",
    timeoutSeconds: REMIND_TIMEOUT_SECONDS,
    plan: "starter",
    retry: REMIND_RETRY,
  },
  remindRepostImpl,
);
