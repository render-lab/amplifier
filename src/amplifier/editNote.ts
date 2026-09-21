import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { get as kvGet } from "@render-lab/tasks-render-kv";
import { loadConfig } from "../config.js";
import { respondEphemeral, type ResponseFetch } from "../slack/respond.js";
import { updateNote } from "../slack/updateNote.js";
import { withLead } from "./lead.js";
import { repostedKey } from "./reposted.js";
import { noStoredNoteMessage, readNote, storeNote } from "./storedNote.js";
import { EDIT_RETRY } from "./retry.js";
import * as log from "../log.js";

export interface EditNoteInput {
  /** Channel the note is in, as the id the click carried. */
  channel: string;
  /** The note's `ts`. */
  messageTs: string;
  /** Key Value key of the stored note, from the Edit button. */
  noteKey: string;
  /** The new lead line, already trimmed and non-empty. */
  lead: string;
  /** Slack URL for answering the editor privately, from the Edit click. */
  responseUrl: string;
}

/** Why a submitted edit changed nothing. */
export type EditRefusal = "no-note" | "no-lead" | "slack-error";

export interface EditNoteResult {
  edited: boolean;
  reason?: EditRefusal;
}

export interface EditNoteDeps {
  /** Used for the `response_url` posts, which are not Slack API calls. */
  fetchImpl?: ResponseFetch;
}

/**
 * Raw implementation of amplifier.editNote.
 *
 * The note in the channel and the stored copy the Repost button posts both
 * change, so a repost carries what the channel shows.
 *
 * Slack first, Key Value second. A refused `chat.update` leaves both on the old
 * text, which the editor can retry from. A failed store throws and EDIT_RETRY
 * re-runs both writes, which repeat harmlessly.
 */
export async function editNoteImpl(
  ctx: TaskContext,
  input: EditNoteInput,
  env: NodeJS.ProcessEnv = process.env,
  deps: EditNoteDeps = {},
): Promise<EditNoteResult> {
  const config = loadConfig({}, env);
  const reply = (text: string) => respondEphemeral(input.responseUrl, text, deps.fetchImpl);

  const note = await readNote(ctx, input.noteKey);
  if (note === null) {
    await reply(noStoredNoteMessage("edit", config.seenTtlSeconds));
    return { edited: false, reason: "no-note" };
  }

  const parent = withLead(note.parent, input.lead);
  if (parent === null) {
    await reply("This note has no text amplifier can edit.");
    return { edited: false, reason: "no-lead" };
  }

  if (config.dryRun) {
    log.info(`[dry run] would rewrite ${input.noteKey} as: ${input.lead}`);
    return { edited: false };
  }

  const update = await ctx.run(updateNote, {
    channel: input.channel,
    messageTs: input.messageTs,
    text: parent.text,
    ...(parent.blocks ? { blocks: parent.blocks } : {}),
  });
  if (!update.updated) {
    await reply(`Slack would not change the note: ${update.error}.`);
    return { edited: false, reason: "slack-error" };
  }

  // The TTL starts over here, so an edited note's stored copy outlives its
  // announced marker by however long it sat before the edit. That costs one Key
  // Value record and keeps the Repost button working for the full window.
  await storeNote(ctx, input.noteKey, { ...note, parent }, config.seenTtlSeconds);

  const { value: reposted } = await ctx.run(kvGet, { key: repostedKey(input.noteKey) });
  await reply(
    reposted === null
      ? "Updated. Reposting your edited message."
      : `Updated here. This note was already reposted${
          config.repostChannel ? ` to #${config.repostChannel}` : ""
        }, and that copy is unchanged.`,
  );
  return { edited: true };
}

/** Change an announced note's lead line, in the channel and in the stored copy. */
export const editNote = task({ name: "amplifier.editNote", retry: EDIT_RETRY }, editNoteImpl);
