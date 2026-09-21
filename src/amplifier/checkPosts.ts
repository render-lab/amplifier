import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { loadConfig, MAX_LIMIT, type CheckPostsInput } from "../config.js";
import { listPublished } from "../typefully/listPublished.js";
import type { Platform } from "../typefully/types.js";
import { announceGroups, type NoteResult } from "./announce.js";
import { groupPosts } from "./group.js";
import { announcedDraftIds, runToken } from "./seen.js";
import { pendingForDraft, settleDeadlineMs, StillPublishingError } from "./settle.js";
import { withinWindow } from "./window.js";
import * as log from "../log.js";

export type { NoteResult };

export interface CheckPostsResult {
  /** Published drafts that mapped to a post amplifier can announce. */
  scanned: number;
  /** Of those, the ones inside the lookback window. */
  inWindow: number;
  /** Announcements the unannounced posts collapsed into. */
  groups: number;
  notified: number;
  /**
   * Drafts this run did not announce: ones an earlier run already announced,
   * plus ones in a group another run is announcing right now.
   */
  skipped: number;
  dryRun: boolean;
  /** Platforms announced without a link because the settle deadline passed. */
  droppedPlatforms: Platform[];
  notes: NoteResult[];
}

/** Raw implementation of amplifier.checkPosts. */
export async function checkPostsImpl(
  ctx: TaskContext,
  input: CheckPostsInput = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckPostsResult> {
  const config = loadConfig(input, env);
  const nowMs = input.now ? Date.parse(input.now) : Date.now();
  if (!Number.isFinite(nowMs)) {
    throw new Error(`input.now is not a parseable timestamp: ${input.now}`);
  }

  const { posts } = await ctx.run(listPublished, {
    ...(config.socialSetId ? { socialSetId: config.socialSetId } : {}),
    limit: config.limit,
  });

  const recent = withinWindow(posts, nowMs, config.lookbackMinutes);
  if (posts.length >= config.limit && recent.length === 0) {
    log.warn(
      `[amplifier] Typefully returned ${posts.length} posts, the requested limit, and none ` +
        `is inside the ${config.lookbackMinutes}-minute lookback. The response may be ` +
        `truncated to the oldest published drafts. Raise AMPLIFIER_LIMIT, up to ${MAX_LIMIT}.`,
    );
  }

  // Dedupe per draft, before grouping: which drafts share a note depends on
  // what this run's response held, so the group is not a stable identity.
  const announced = await announcedDraftIds(
    ctx,
    recent.map((p) => p.draftId),
  );

  // Settle check. It sits after the marker read, so a draft an earlier run
  // already announced never blocks, and before `claimGroup`, so no in-flight
  // lock is held across the retry backoff.
  let droppedPlatforms: Platform[] = [];
  if (
    config.settleMinutes > 0 &&
    input.eventAt !== undefined &&
    input.draftId !== undefined &&
    !announced.has(input.draftId)
  ) {
    const pending = pendingForDraft(recent, input.draftId);
    if (pending.length > 0) {
      const deadlineMs = settleDeadlineMs(input.eventAt, config.settleMinutes);
      if (nowMs < deadlineMs) {
        throw new StillPublishingError(input.draftId, pending, deadlineMs);
      }
      log.warn(
        `[amplifier] The settle deadline passed for draft ${input.draftId}. Announcing it ` +
          `without ${pending.join(", ")}.`,
      );
      droppedPlatforms = pending;
    }
  }

  const unannounced = recent.filter((p) => !announced.has(p.draftId));
  const groups = groupPosts(unannounced, config.groupWindowMinutes);

  const { notes, skipped } = await announceGroups(ctx, groups, config, runToken(), {
    ...(input.draftId !== undefined && droppedPlatforms.length > 0
      ? { droppedFor: { draftId: input.draftId, platforms: droppedPlatforms } }
      : {}),
  });

  return {
    scanned: posts.length,
    inWindow: recent.length,
    groups: groups.length,
    notified: notes.filter((n) => n.delivered).length,
    skipped: skipped + announced.size,
    dryRun: config.dryRun,
    droppedPlatforms,
    notes,
  };
}

/** Announce newly published Render posts to Slack, once each. */
export const checkPosts = task({ name: "amplifier.checkPosts" }, checkPostsImpl);
