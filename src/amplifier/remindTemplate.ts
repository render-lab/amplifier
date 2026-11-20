import type { SlackBlock } from "@render-lab/tasks-slack";
import type { PostNoteInput } from "../slack/postNote.js";
import { channelMention } from "../slack/mrkdwn.js";
import { repostBlock, repostLabel, section } from "./template.js";

/**
 * Stand-in for the repost channel's name inside the reminder text.
 *
 * The text is a setting and the channel is a different setting, so the two are
 * joined here rather than in the value somebody types into
 * AMPLIFIER_REMINDER_TEXT. An override that leaves the placeholder out still
 * posts; it just does not name the channel. A `#` before the placeholder is
 * replaced with it, because the replacement brings its own.
 */
export const CHANNEL_PLACEHOLDER = "{channel}";

/** The placeholder and any `#` typed before it. */
const PLACEHOLDER_PATTERN = /#?\{channel\}/g;

/** The reminder's text. Override with AMPLIFIER_REMINDER_TEXT. */
export const DEFAULT_REMINDER_TEXT =
  `This post still needs to be shared in ${CHANNEL_PLACEHOLDER}. The first hour matters most, ` +
  `so can the owner or another team member share it?`;

export interface RemindOptions {
  /** Channel the note is in. */
  channel: string;
  /** The note's parent `ts`, which the reminder replies to. */
  threadTs: string;
  /** The reminder's text, with CHANNEL_PLACEHOLDER for the repost channel. */
  text: string;
  /** Channel the Repost button posts to, as the placeholder resolves to. */
  repostChannel: string;
  /** Name the button shows when `repostChannel` is an id. */
  repostChannelName?: string;
  /** Key Value key of the stored note, which the reminder's own button carries. */
  noteKey: string;
}

/**
 * The reminder one un-reposted note gets.
 *
 * A broadcast reply, so it shows in the channel as well as in the thread. It
 * carries its own Repost button, holding the same note key as the parent's, so
 * somebody reading the reminder in the channel can act on it without scrolling
 * back to the note.
 *
 * `blocks` rather than `markdown`, because the button needs an `actions` block
 * and `renderBlocks` builds blocks from `markdown` only when `blocks` is
 * absent. `text` is the notification fallback.
 */
export function renderReminder(opts: RemindOptions): PostNoteInput {
  const text = opts.text.replaceAll(PLACEHOLDER_PATTERN, channelMention(opts.repostChannel));
  const label = repostLabel(opts.repostChannel, opts.repostChannelName);
  const blocks: SlackBlock[] = [section(text), repostBlock(label, opts.noteKey)];
  return {
    text,
    blocks,
    channel: opts.channel,
    threadTs: opts.threadTs,
    broadcast: true,
  };
}
