import type { TaskContext } from "@renderinc/sdk/workflows";
import type { PostMessageInput } from "@render-lab/tasks-slack";
import type { AmplifierConfig } from "../config.js";
import { postNote } from "../slack/postNote.js";
import { postReplies } from "../slack/thread.js";
import { isSummary, summarizeGroup, type SummaryOutcome } from "../summary/summarize.js";
import type { Platform } from "../typefully/types.js";
import { startRun as defaultStartRun, type StartRun } from "./dispatchRun.js";
import type { PostGroup } from "./group.js";
import { pingOwners } from "./pingOwners.js";
import { claimGroup, isClaimed, markAnnounced, releaseGroup } from "./seen.js";
import { noteKey, storeNote } from "./storedNote.js";
import * as log from "../log.js";
import {
  notePlatforms,
  renderChildren,
  renderFlatNote,
  renderParent,
  sectionMrkdwn,
  type RenderNoteOptions,
} from "./template.js";

/** One announcement's outcome. */
export interface NoteResult {
  draftIds: string[];
  platforms: Platform[];
  /** false in dry run, and false when the Slack port reported no delivery. */
  delivered: boolean;
  /** Whether the model wrote this note's lead line. False means the fallback text. */
  summarized: boolean;
  /** The parent message's `ts`, when the note was posted as a thread. */
  threadTs?: string;
}

export interface AnnounceOptions {
  /** Platforms to name as dropped, and the draft whose note names them. */
  droppedFor?: { draftId: string; platforms: Platform[] };
  /** Starts the repost reminder's own run. Defaults to the Render API dispatch. */
  startRun?: StartRun;
}

export interface AnnounceResult {
  notes: NoteResult[];
  /** Drafts left unannounced because another run holds the claim or already announced them. */
  skipped: number;
}

/**
 * Summarize, claim, post, mark, release — once per group.
 *
 * Both `amplifier.checkPosts` and `amplifier.announcePost` call this, so the
 * announce-once guarantee has one implementation.
 */
export async function announceGroups(
  ctx: TaskContext,
  groups: PostGroup[],
  config: AmplifierConfig,
  runToken: string,
  opts: AnnounceOptions = {},
): Promise<AnnounceResult> {
  const notes: NoteResult[] = [];
  let skipped = 0;

  for (const group of groups) {
    // Before the claim, not inside it. LLM_RETRY spends about 62 seconds of
    // backoff across 5 retries plus six call durations, and the in-flight lock
    // lives 300 seconds — inside the claim, the lock can expire mid-flight and
    // the next run re-posts the note. The cost is one wasted call when two runs
    // race the same group.
    const summary = await summarizeGroup(ctx, group, { model: config.summaryModel });
    if (!isSummary(summary)) {
      log.error(
        `[amplifier] No summary for ${group.draftIds.join(", ")}: ${summary.error}. ` +
          `Posting the fallback note.`,
      );
    }

    const outcome = await claimGroup(ctx, group, runToken);
    if (!isClaimed(outcome)) {
      skipped += group.draftIds.length;
      continue;
    }
    const { claims } = outcome;

    // Only the event's draft went through the settle check, so only its note
    // names the platforms the deadline dropped.
    const dropped =
      opts.droppedFor !== undefined && group.draftIds.includes(opts.droppedFor.draftId)
        ? opts.droppedFor.platforms
        : [];

    const { parent, replies, platforms, key } = renderGroup(group, config, summary, dropped);

    let delivered = false;
    let threadTs: string | undefined;
    // The channel id Slack echoed back. `parent.channel` may be a bare name,
    // and `chat.getPermalink` reads an id only.
    let noteChannel: string | undefined;
    if (config.dryRun) {
      logDryRun(parent, replies);
    } else {
      try {
        const posted = await ctx.run(postNote, parent);
        delivered = posted.delivered;
        threadTs = posted.ts;
        noteChannel = posted.channel;
        if (delivered) {
          await markAnnounced(ctx, group.draftIds, config.seenTtlSeconds);
        }
      } catch (err) {
        await releaseGroup(ctx, claims);
        throw err;
      }

      if (!delivered) {
        // The Slack port reported the note undelivered without throwing. The
        // real ports either deliver or throw, so this is reachable only through
        // injected deps. Nothing reached the channel, so leave the drafts
        // unannounced and let a later run retry them.
        log.error(
          `[amplifier] The Slack port reported the note for ${group.draftIds.join(", ")} ` +
            `undelivered. Those drafts stay unannounced and a later run retries them.`,
        );
      } else {
        // Stored for a flat note too, not only a thread, because both carry the
        // Repost button now.
        if (config.repostChannel) {
          await storeNote(ctx, key, { parent, replies }, config.seenTtlSeconds);
        }
        if (replies.length > 0) {
          await postLinkReplies(ctx, group, replies, threadTs);
        }
        if (config.pingOwners) {
          await pingLaunchOwners(ctx, group, noteChannel, threadTs);
        }
        await scheduleReminder(config, noteChannel ?? parent.channel, threadTs, key, opts.startRun);
      }
    }
    await releaseGroup(ctx, claims);
    notes.push({
      draftIds: group.draftIds,
      platforms,
      delivered,
      summarized: isSummary(summary),
      ...(threadTs ? { threadTs } : {}),
    });
  }

  return { notes, skipped };
}

/** The messages one announcement posts. */
interface RenderedNote {
  parent: PostMessageInput;
  /** One reply per platform link. Empty when the note is a single message. */
  replies: PostMessageInput[];
  /** Platforms the note covers, in display order. */
  platforms: Platform[];
  /** Key Value key the thread is stored under, and the value the button carries. */
  key: string;
}

/**
 * Render one group into the messages it posts.
 *
 * A group covering more than one platform becomes a parent message plus one
 * reply per link. A single-platform group stays one flat message, because one
 * link is not a thread.
 */
function renderGroup(
  group: PostGroup,
  config: AmplifierConfig,
  summary: SummaryOutcome,
  dropped: Platform[],
): RenderedNote {
  const noteOpts: RenderNoteOptions = {
    ...(config.slackChannel ? { channel: config.slackChannel } : {}),
    callToAction: config.callToAction,
    ...(isSummary(summary) ? { summary: summary.line } : { summaryError: summary.error }),
    ...(dropped.length > 0 ? { droppedPlatforms: dropped } : {}),
  };
  const platforms = notePlatforms(group);
  const replies = platforms.length > 1 ? renderChildren(group, noteOpts) : [];
  const key = noteKey(group.draftIds);
  const repostOpts = config.repostChannel
    ? { repostChannel: config.repostChannel, noteKey: key }
    : {};
  const parent =
    replies.length > 0
      ? renderParent(group, { ...noteOpts, ...repostOpts })
      : renderFlatNote(group, { ...noteOpts, ...repostOpts });
  return { parent, replies, platforms, key };
}

/**
 * Post the thread's links as replies under the note.
 *
 * A failure is logged rather than thrown. The announced marker is already
 * written, so throwing here would leave the drafts unmarked and a later run
 * would post a second parent; a thread missing one link is the smaller problem.
 */
async function postLinkReplies(
  ctx: TaskContext,
  group: PostGroup,
  replies: PostMessageInput[],
  threadTs: string | undefined,
): Promise<void> {
  if (threadTs === undefined) {
    log.error(
      `[amplifier] Slack returned no ts for the note on ${group.draftIds.join(", ")}, so its ` +
        `${replies.length} links cannot be posted as replies.`,
    );
    return;
  }
  await postReplies(ctx, replies, threadTs, (err) => {
    log.error(
      `[amplifier] A thread reply for ${group.draftIds.join(", ")} failed. The thread is ` +
        `missing a link and the drafts stay announced.`,
      err,
    );
  });
}

/**
 * DM the launch's owners the link to the note that just went out.
 *
 * Last, so a Notion database nobody configured cannot cost the channel its
 * announcement, and a failure is logged rather than thrown for the same reason.
 * `amplifier.pingOwners` has its own once-only marker, so a re-announced group
 * does not DM anybody twice.
 *
 * A dry run never reaches here, because there is no posted note to link to.
 *
 * The group's first draft id is the needle. A group holding two drafts is two
 * Typefully drafts of one launch, and the page carries one Typefully link, so a
 * group whose page names the second draft finds no page and DMs nobody.
 */
async function pingLaunchOwners(
  ctx: TaskContext,
  group: PostGroup,
  channel: string | undefined,
  threadTs: string | undefined,
): Promise<void> {
  const draftId = group.draftIds[0];
  if (draftId === undefined) return;
  try {
    await ctx.run(pingOwners, {
      draftId,
      ...(channel ? { noteChannel: channel } : {}),
      ...(threadTs ? { noteTs: threadTs } : {}),
    });
  } catch (err) {
    log.error(
      `[amplifier] The owner DMs for ${group.draftIds.join(", ")} failed. The note is already ` +
        `in the channel. Set AMPLIFIER_PING_OWNERS=false to stop trying.`,
      err,
    );
  }
}

/**
 * Start the run that reminds the channel if nobody reposts this note.
 *
 * Its own run, because the delay is a 30-minute sleep inside
 * `amplifier.remindRepost`. Holding that sleep here would mean cancelling or
 * redeploying the announce path takes the reminder with it.
 *
 * Caught rather than thrown: the note is already in the channel, so a failed
 * dispatch must not fail the announce run or re-post the note.
 *
 * `channel` is the id Slack echoed back, falling back to the configured name.
 * Only the reminder's own reply goes there. Both markers are keyed by the note
 * key, which `amplifier.repost` has too, so the two paths cannot disagree about
 * which channel a note is in.
 *
 * The reminder carries its own Repost button, so it needs the same note key the
 * parent's button holds. The stored note lives as long as the announced marker,
 * so the key still resolves half an hour later.
 */
async function scheduleReminder(
  config: AmplifierConfig,
  channel: string | undefined,
  threadTs: string | undefined,
  noteKey: string,
  start: StartRun = defaultStartRun,
): Promise<void> {
  if (config.reminderMinutes === 0 || !config.repostChannel) return;
  if (channel === undefined || threadTs === undefined) return;
  try {
    await start("amplifier.remindRepost", [
      {
        channel,
        messageTs: threadTs,
        dueAtMs: Date.now() + config.reminderMinutes * 60_000,
        noteKey,
      },
    ]);
  } catch (err) {
    log.error("[amplifier] The repost reminder run did not start.", err);
  }
}

/** Log the parent and every reply, in the order a real run would post them. */
function logDryRun(parent: PostMessageInput, replies: PostMessageInput[]): void {
  log.info(`[dry run] would post:\n${messageText(parent)}`);
  for (const reply of replies) {
    log.info(`[dry run] would reply:\n${messageText(reply)}`);
  }
}

/**
 * A message's body as text, for the dry-run log.
 *
 * The parent carries `blocks` and no `markdown`, so the section blocks are read
 * back out. Anything else falls back to the notification text.
 */
function messageText(message: PostMessageInput): string {
  if (message.markdown) return message.markdown;
  const sections = (message.blocks ?? []).flatMap((block) => {
    const text = sectionMrkdwn(block);
    return text === undefined ? [] : [text];
  });
  return sections.length > 0 ? sections.join("\n\n") : message.text;
}
