/** Join the non-empty parts of a message the way Slack renders paragraphs. */
export function body(parts: string[]): string {
  return parts.filter((s) => s !== "").join("\n\n");
}

/**
 * Whether a channel setting is a Slack id and not a name.
 *
 * Public channel ids start with `C` and private ones with `G`. Channel names
 * are lowercase, so a name never matches.
 */
export function isChannelId(channel: string): boolean {
  return /^[CG][A-Z0-9]{6,}$/.test(channel);
}

/**
 * A channel reference in mrkdwn.
 *
 * Slack renders `<#C0123>` as the channel's name, so an id needs no lookup
 * here. A name is written as `#name`.
 */
export function channelMention(channel: string): string {
  return isChannelId(channel) ? `<#${channel}>` : `#${channel}`;
}
