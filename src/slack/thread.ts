import type { TaskContext } from "@renderinc/sdk/workflows";
import { postNote, type PostNoteInput } from "./postNote.js";

/**
 * Post a note's replies under one parent, in order.
 *
 * Sequential and not `Promise.all`, because the order the links appear in the
 * thread is part of the note's format.
 *
 * A failed reply is handed to `onFailure` rather than thrown. By the time this
 * runs the parent is already posted, so throwing would retry the whole task and
 * post a second thread; each reply is its own subtask under SLACK_RETRY, so a
 * transient failure has already been retried. The caller says in the log what a
 * missing link costs it.
 *
 * An absent `threadTs` posts each reply on its own, because Slack reported no
 * parent to hang them under.
 */
export async function postReplies(
  ctx: TaskContext,
  replies: PostNoteInput[],
  threadTs: string | undefined,
  onFailure: (err: unknown) => void,
): Promise<void> {
  for (const reply of replies) {
    try {
      await ctx.run(postNote, { ...reply, ...(threadTs ? { threadTs } : {}) });
    } catch (err) {
      onFailure(err);
    }
  }
}
