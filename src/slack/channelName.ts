import { task, type Retry, type TaskContext } from "@renderinc/sdk/workflows";
import { nonEmptyString, record } from "../json.js";
import { callSlack } from "./api.js";
import { isChannelId } from "./mrkdwn.js";
import * as log from "../log.js";

export interface ChannelNameInput {
  /** Slack channel id, such as `C0123ABCD`. */
  channel: string;
}

/** The channel's name without the `#`, or the Slack error code that says why there is none. */
export type ChannelNameResult = { name: string } | { error: string };

/**
 * Raw implementation of amplifier.channelName.
 *
 * `conversations.info` needs `channels:read` for a public channel. A private
 * channel also needs `groups:read` and the bot as a member, so it answers
 * `channel_not_found` here. Both errors are returned and not thrown, because a
 * missing name only changes a button label.
 */
export async function channelNameImpl(
  _ctx: TaskContext,
  input: ChannelNameInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChannelNameResult> {
  const body = await callSlack("conversations.info", { channel: input.channel }, { env });
  const name = nonEmptyString(record(body["channel"])?.["name"]);
  if (!name) return { error: body.error ?? "no_name_in_response" };
  return { name };
}

/**
 * Retry policy for amplifier.channelName: one retry after 1s.
 *
 * Shorter than SLACK_RETRY, because the name only changes a label and the
 * caller has a fallback. A long backoff would hold back the note it labels.
 */
const CHANNEL_NAME_RETRY: Retry = { maxRetries: 1, waitDurationMs: 1_000, backoffScaling: 1 };

/** The name of a Slack channel, from its id. */
export const channelName = task(
  { name: "amplifier.channelName", retry: CHANNEL_NAME_RETRY },
  channelNameImpl,
);

/**
 * The name to show for a channel setting, which may be a name or an id.
 *
 * A name is returned as it is, with no Slack call. An id is looked up, and
 * undefined is returned when the lookup fails, so the caller shows no name and
 * not the raw id. A failure is logged and not thrown, because the note must
 * still go out.
 */
export async function channelDisplayName(
  ctx: TaskContext,
  channel: string,
): Promise<string | undefined> {
  if (!isChannelId(channel)) return channel;
  try {
    const result = await ctx.run(channelName, { channel });
    if ("name" in result) return result.name;
    log.error(
      `[amplifier] Slack gave no name for ${channel}: ${result.error}. A public channel ` +
        `needs the channels:read bot scope, and a private channel also needs the bot as a member.`,
    );
  } catch (err) {
    log.error(`[amplifier] Could not look up the name of ${channel}.`, err);
  }
  return undefined;
}
