import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { deleteKeys, get as kvGet } from "@render-lab/tasks-render-kv";
import { loadConfig } from "../config.js";
import { findPost } from "../typefully/match.js";
import { announceGroups, type NoteResult } from "./announce.js";
import { groupPosts } from "./group.js";
import { runToken, seenKey } from "./seen.js";

export interface AnnouncePostInput {
  /** Permalink to the live post, or its Typefully share URL. Either this or draftId. */
  url?: string;
  /** Typefully draft id, when the URL is not to hand. */
  draftId?: string;
  /** Announce a draft the seen marker already records. Re-posts the note. */
  force?: boolean;
  dryRun?: boolean;
  slackChannel?: string;
}

export interface AnnouncePostResult {
  draftId: string;
  dryRun: boolean;
  /** Absent when the draft was already announced and force was not set. */
  note?: NoteResult;
  /** Set when nothing was posted, naming why. */
  skipped?: "announced" | "claimed";
}

/** Raw implementation of amplifier.announcePost. */
export async function announcePostImpl(
  ctx: TaskContext,
  input: AnnouncePostInput = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<AnnouncePostResult> {
  if (input.url === undefined && input.draftId === undefined) {
    throw new Error("Pass the post's permalink as url, or its Typefully id as draftId.");
  }

  const config = loadConfig(
    {
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      ...(input.slackChannel !== undefined ? { slackChannel: input.slackChannel } : {}),
    },
    env,
  );

  const post = await findPost(ctx, input, config.socialSetId);

  const key = seenKey(post.draftId);
  const { value } = await ctx.run(kvGet, { key });
  if (value !== null) {
    if (!input.force) {
      console.log(
        `[amplifier] Draft ${post.draftId} is already announced. Pass force: true to re-post it.`,
      );
      return { draftId: post.draftId, dryRun: config.dryRun, skipped: "announced" };
    }
    await ctx.run(deleteKeys, { keys: [key] });
    console.log(`[amplifier] Cleared the announced marker for draft ${post.draftId}.`);
  }

  // A group window of 0, so a cross-posted draft still makes one note holding
  // both permalinks and no neighbouring draft joins it.
  const groups = groupPosts([post], 0);
  const { notes } = await announceGroups(ctx, groups, config, runToken());

  const note = notes[0];
  if (!note) {
    // Another run holds the claim and is posting the same note right now.
    return { draftId: post.draftId, dryRun: config.dryRun, skipped: "claimed" };
  }

  return { draftId: post.draftId, dryRun: config.dryRun, note };
}

/**
 * Announce one published post to Slack, given its permalink.
 *
 * `announceGroups` DMs the launch's owners afterwards, so there is no flag for
 * it here. Set AMPLIFIER_PING_OWNERS to false to turn the DMs off.
 *
 * No retry policy, matching `amplifier.checkPosts`. A human is watching this
 * one, and a retry after a delivered note would read its own marker and do
 * nothing useful.
 */
export const announcePost = task({ name: "amplifier.announcePost" }, announcePostImpl);
