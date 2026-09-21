import type { TaskContext } from "@renderinc/sdk/workflows";
import { get as kvGet, set as kvSet } from "@render-lab/tasks-render-kv";
import type { PostMessageInput } from "@render-lab/tasks-slack";
import { SECONDS_PER_DAY } from "../time.js";
import * as log from "../log.js";

/**
 * A posted thread, kept so `amplifier.repost` can post it again.
 *
 * `amplifier.repost` needs the thread's content, and `@render-lab/tasks-slack`
 * 0.3.0 wraps no `conversations.replies` task, so reading the thread back from
 * Slack would mean a raw API call and a `channels:history` scope. `announce`
 * writes the rendered messages here instead, when it posts them.
 */
export interface StoredNote {
  parent: PostMessageInput;
  replies: PostMessageInput[];
}

/** Prefix every stored-note key carries. */
const NOTE_PREFIX = "amplifier:note:";

/**
 * Key the posted thread is stored under. The button carries this string.
 *
 * Keyed by the group's drafts and not by the parent's `ts`, because the button
 * is built into the parent before it is posted and the `ts` only comes back
 * afterwards. Re-announcing the same drafts overwrites the record.
 */
export function noteKey(draftIds: string[]): string {
  return `${NOTE_PREFIX}${draftIds.join("+")}`;
}

/**
 * The drafts inside a stored-note key, which the repost markers key by.
 *
 * A key from anywhere but `noteKey` is passed through, so a marker is still
 * namespaced by whatever the button carried.
 */
export function noteIds(key: string): string {
  return key.startsWith(NOTE_PREFIX) ? key.slice(NOTE_PREFIX.length) : key;
}

/** Store a posted thread under the announced marker's TTL. */
export async function storeNote(
  ctx: TaskContext,
  key: string,
  note: StoredNote,
  ttlSeconds: number,
): Promise<void> {
  await ctx.run(kvSet, { key, value: JSON.stringify(note), ttlSeconds });
}

/**
 * Read a stored thread back, or null when it is gone.
 *
 * The record carries the announced marker's TTL, so a miss means the note is
 * older than AMPLIFIER_SEEN_TTL_DAYS. Unparseable JSON reads as a miss, because
 * the only caller's answer to both is the same ephemeral message.
 */
export async function readNote(ctx: TaskContext, key: string): Promise<StoredNote | null> {
  const { value } = await ctx.run(kvGet, { key });
  if (value === null) return null;
  try {
    return JSON.parse(value) as StoredNote;
  } catch {
    log.error(`[amplifier] The stored note ${key} is not readable JSON.`);
    return null;
  }
}

/**
 * What a clicker hears when `readNote` found nothing.
 *
 * Both the Repost and the Edit path answer a miss the same way, because the
 * record carries the announced marker's TTL and a miss means the note is older
 * than AMPLIFIER_SEEN_TTL_DAYS. `action` is the verb for the click that missed.
 */
export function noStoredNoteMessage(action: "repost" | "edit", ttlSeconds: number): string {
  return (
    `Amplifier has no stored text for this note, so it cannot ${action} it. A note is kept ` +
    `for ${ttlSeconds / SECONDS_PER_DAY} days, so this one has probably expired.`
  );
}
