import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { SLACK_RETRY } from "@render-lab/tasks-slack";
import { nestedId } from "../json.js";
import { callSlack } from "./api.js";

export interface LookupUserInput {
  /** The address to match a Slack account on, usually from a Notion people property. */
  email: string;
}

export interface OpenDmInput {
  /** Slack user id, as `users.lookupByEmail` reported it. */
  userId: string;
}

/** A lookup that matched, or the Slack error code that says why it did not. */
export type LookupUserResult = { userId: string } | { error: string };

/** An opened DM, or the Slack error code that says why it did not open. */
export type OpenDmResult = { channelId: string } | { error: string };

/**
 * Raw implementation of amplifier.lookupUser.
 *
 * An owner whose address has no Slack account answers `users_not_found`, which
 * is returned rather than thrown: the run reports that owner in the channel and
 * still DMs the others.
 *
 * The call needs `users:read.email`, which Slack only grants alongside
 * `users:read`. Without it Slack answers `missing_scope`, which reads the same
 * way here — nobody gets a DM and the channel note names why.
 */
export async function lookupUserImpl(
  _ctx: TaskContext,
  input: LookupUserInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LookupUserResult> {
  const email = input.email?.trim();
  if (!email) return { error: "no_email" };

  const body = await callSlack("users.lookupByEmail", { email }, { env });
  const id = nestedId(body, "user");
  if (!id) return { error: body.error ?? "no_user_in_response" };
  return { userId: id };
}

/**
 * Raw implementation of amplifier.openDm.
 *
 * `im:write` is the scope. The channel id it returns is stable per user, so
 * re-opening a DM is not a second conversation.
 */
export async function openDmImpl(
  _ctx: TaskContext,
  input: OpenDmInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OpenDmResult> {
  const user = input.userId?.trim();
  if (!user) return { error: "no_user_id" };

  const body = await callSlack("conversations.open", { users: user }, { env });
  const id = nestedId(body, "channel");
  if (!id) return { error: body.error ?? "no_channel_in_response" };
  return { channelId: id };
}

/** The Slack user id for an email address. */
export const lookupUser = task(
  { name: "amplifier.lookupUser", retry: SLACK_RETRY },
  lookupUserImpl,
);

/** The DM channel id for a Slack user. */
export const openDm = task({ name: "amplifier.openDm", retry: SLACK_RETRY }, openDmImpl);
