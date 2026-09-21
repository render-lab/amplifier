import type { PostMessageInput, SlackBlock, SlackJsonValue } from "@render-lab/tasks-slack";
import { body } from "../slack/mrkdwn.js";
import { compareTime } from "../time.js";
import { PLATFORM_NAMES, PLATFORM_ORDER, platformLabel } from "../typefully/platforms.js";
import type { Platform, PlatformLink } from "../typefully/types.js";
import type { PostGroup } from "./group.js";

/** The note's opening line and the amplify ask. Override with AMPLIFIER_CALL_TO_ACTION. */
export const DEFAULT_CALL_TO_ACTION =
  "New Render social post! Please like and share when you have a minute";

/** The `action_id` the receiver matches to tell the Repost button from any other block action. */
export const REPOST_ACTION_ID = "amplifier_repost";

/** The `action_id` that tells an Edit click from a Repost click. */
export const EDIT_ACTION_ID = "amplifier_edit";

/** Marks the parent of a thread whose links are replies. */
export const THREAD_MARKER = " 🧵";

export interface RenderNoteOptions {
  /** Slack channel to post to. Requires SLACK_BOT_TOKEN to be honored. */
  channel?: string;
  callToAction?: string;
  /** The model's one-line summary. When present it is the note's whole lead line. */
  summary?: string;
  /** Why there is no summary, shown under the fallback lead line. */
  summaryError?: string;
  /** Platforms the note has no link for because the settle deadline passed. */
  droppedPlatforms?: Platform[];
}

export interface RenderParentOptions extends RenderNoteOptions {
  /** Channel the Repost button posts to. Unset means the parent carries no button. */
  repostChannel?: string;
  /** Key Value key the button hands back, so the repost task can read the note. */
  noteKey?: string;
}

/** One link per platform in display order, keeping the earliest of any duplicates. */
function orderedLinks(group: PostGroup): PlatformLink[] {
  const byPlatform = new Map<Platform, PlatformLink>();
  for (const link of group.links) {
    const seen = byPlatform.get(link.platform);
    if (!seen || compareTime(link.publishedAt, seen.publishedAt) < 0) {
      byPlatform.set(link.platform, link);
    }
  }
  return PLATFORM_ORDER.flatMap((p) => {
    const link = byPlatform.get(p);
    return link ? [link] : [];
  });
}

/** Platforms this note covers, in display order. */
export function notePlatforms(group: PostGroup): Platform[] {
  return orderedLinks(group).map((l) => l.platform);
}

/**
 * The line naming platforms the note has no link for.
 *
 * A dropped platform never reaches `orderedLinks`, so without this line the
 * note reads as a complete announcement of a partial cross-post and nobody in
 * the channel learns a link is missing.
 */
function droppedLine(dropped: Platform[]): string {
  if (dropped.length === 0) return "";
  const names = PLATFORM_ORDER.filter((p) => dropped.includes(p)).map((p) => PLATFORM_NAMES[p]);
  const missing = names.length > 1 ? "there are no links for them" : "there is no link for it";
  return `_${names.join(" and ")} had not published yet, so ${missing}._`;
}

function linkMrkdwn(link: PlatformLink, shareUrl: string | undefined): string {
  const label = platformLabel(link.platform);
  if (link.url) return `<${link.url}|${label}>`;
  if (shareUrl) return `<${shareUrl}|${label} (Typefully draft)>`;
  return `${label} (link pending)`;
}

/** The lead line: the summary when there is one, else the call to action. */
function leadLine(opts: RenderNoteOptions): string {
  return opts.summary?.trim() || opts.callToAction?.trim() || DEFAULT_CALL_TO_ACTION;
}

/**
 * The fallback body, used whenever the model wrote no summary.
 *
 * It carries the call to action, the reason the summary is missing, and the
 * draft's preview as a quote — the preview is the only content signal left, so
 * it is worth the extra lines.
 */
function fallbackBlocks(group: PostGroup, opts: RenderNoteOptions, lead: string): string[] {
  const failure = opts.summaryError
    ? `\n_(Summarization LLM call failed: ${opts.summaryError})_`
    : "";
  const quotes = group.previews
    .filter((p) => p !== "")
    .map((p) => `> ${p}`)
    .join("\n>\n");
  return [`${lead}${failure}`, quotes];
}

/** A mrkdwn section block, the only block shape these notes use for text. */
export function section(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

/**
 * A section block's mrkdwn, or undefined for any other block.
 *
 * `SlackBlock` is an index type in `@render-lab/tasks-slack` 0.3.0, so reading
 * the nested `text.text` needs a cast. Everything that reads a posted note back
 * out of its blocks goes through here, so the cast lives in one place.
 */
export function sectionMrkdwn(block: SlackBlock | undefined): string | undefined {
  const text = (block as { text?: { text?: unknown } } | undefined)?.text?.text;
  return typeof text === "string" ? text : undefined;
}

/**
 * The Repost button.
 *
 * `value` is the Key Value key of the stored note, so the receiver can hand the
 * repost task everything it needs to rebuild the thread without reading the
 * thread back from Slack.
 */
function repostElement(repostChannel: string, noteKey: string): SlackJsonValue {
  return {
    type: "button",
    action_id: REPOST_ACTION_ID,
    text: { type: "plain_text", text: `Repost to #${repostChannel}`, emoji: true },
    value: noteKey,
  };
}

/** The Edit button, carrying the same note key as Repost, which the edit rewrites. */
function editElement(noteKey: string): SlackJsonValue {
  return {
    type: "button",
    action_id: EDIT_ACTION_ID,
    text: { type: "plain_text", text: "Edit", emoji: true },
    value: noteKey,
  };
}

/** The reminder's actions block, which offers the repost and nothing else. */
export function repostBlock(repostChannel: string, noteKey: string): SlackBlock {
  return { type: "actions", elements: [repostElement(repostChannel, noteKey)] };
}

/**
 * A note's actions block, holding Repost and Edit.
 *
 * Only a note gets Edit. The reminder is a reply carrying its own text, so an
 * Edit click there would rewrite the reminder.
 */
export function noteActions(repostChannel: string, noteKey: string): SlackBlock {
  return {
    type: "actions",
    elements: [repostElement(repostChannel, noteKey), editElement(noteKey)],
  };
}

/** The body parts above the links: the summary alone, or the whole fallback. */
function noteParts(group: PostGroup, opts: RenderNoteOptions, lead: string): string[] {
  return opts.summary?.trim() ? [lead] : fallbackBlocks(group, opts, lead);
}

/**
 * Assemble one message from its body parts, with the Repost button when the
 * caller named a channel and a key for it.
 *
 * The message supplies `blocks` directly rather than `markdown`. `renderBlocks`
 * builds blocks from `markdown` only when `blocks` is absent, and the button
 * needs an `actions` block, so these notes build their own.
 *
 * `text` is the notification fallback Slack shows in the sidebar and in push
 * notifications. It carries the lead line and no URL: a bare URL here renders
 * an unfurl card.
 */
function noteMessage(lead: string, parts: string[], opts: RenderParentOptions): PostMessageInput {
  const blocks: SlackBlock[] = [section(body(parts))];
  if (opts.repostChannel && opts.noteKey) {
    blocks.push(noteActions(opts.repostChannel, opts.noteKey));
  }
  return {
    text: lead,
    blocks,
    ...(opts.channel ? { channel: opts.channel } : {}),
  };
}

/**
 * Build the parent message of an announcement thread.
 *
 * The body is the lead line and, under a summary, nothing else: the platform
 * links are replies. The 🧵 says so, because a parent with no links reads as a
 * note someone forgot to finish. The dropped-platform line stays here rather
 * than on a reply, because it is about the announcement and not about one link.
 */
export function renderParent(group: PostGroup, opts: RenderParentOptions = {}): PostMessageInput {
  const lead = leadLine(opts);
  const parts = noteParts(group, opts, `${lead}${THREAD_MARKER}`);
  parts.push(droppedLine(opts.droppedPlatforms ?? []));
  return noteMessage(lead, parts, opts);
}

/**
 * Build one reply per platform link, in display order.
 *
 * Order is part of the format, so the caller posts these sequentially rather
 * than racing them.
 */
export function renderChildren(group: PostGroup, opts: RenderNoteOptions = {}): PostMessageInput[] {
  return orderedLinks(group).map((link) => {
    const mrkdwn = linkMrkdwn(link, group.shareUrl);
    return {
      text: platformLabel(link.platform),
      markdown: mrkdwn,
      ...(opts.channel ? { channel: opts.channel } : {}),
    };
  });
}

/**
 * Build the single flat message for an announcement with one link.
 *
 * One link is not a thread, so it stays one message with no 🧵 and no reply.
 * The link is not bulleted, because one link is not a list.
 *
 * It carries the Repost button, the same way `renderParent` does. An owner of a
 * single-platform post is DMed the link to this message, so without the button
 * there is nothing for them to click.
 */
export function renderFlatNote(group: PostGroup, opts: RenderParentOptions = {}): PostMessageInput {
  const lead = leadLine(opts);
  const parts = noteParts(group, opts, lead);
  parts.push(
    orderedLinks(group)
      .map((l) => linkMrkdwn(l, group.shareUrl))
      .join("\n"),
  );
  parts.push(droppedLine(opts.droppedPlatforms ?? []));
  return noteMessage(lead, parts, opts);
}

/**
 * Strip the note's buttons from a stored parent.
 *
 * A reposted thread carries neither button, so a repost can be neither
 * reposted nor edited.
 */
export function withoutNoteActions(parent: PostMessageInput): PostMessageInput {
  if (!parent.blocks) return parent;
  return { ...parent, blocks: parent.blocks.filter((b) => b["type"] !== "actions") };
}
