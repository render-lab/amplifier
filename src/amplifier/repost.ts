import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { get as kvGet, set as kvSet } from "@render-lab/tasks-render-kv";
import { addReaction } from "@render-lab/tasks-slack";
import { loadConfig } from "../config.js";
import {
  authorizeUrl,
  CALLBACK_PATH,
  publicBaseUrl,
  signState,
  userTokenKey,
} from "../slack/oauth.js";
import { postNote } from "../slack/postNote.js";
import { respondEphemeral, type ResponseFetch } from "../slack/respond.js";
import { postReplies } from "../slack/thread.js";
import { claimNote, isRepostClaimed } from "./repostClaim.js";
import { repostedKey } from "./reposted.js";
import { releaseClaim, runToken } from "./seen.js";
import { noStoredNoteMessage, readNote } from "./storedNote.js";
import { withoutNoteActions } from "./template.js";
import { REPOST_RETRY } from "./retry.js";
import * as log from "../log.js";

export interface RepostInput {
  /** Channel the clicked note is in. */
  channel: string;
  /** The clicked parent message's `ts`. */
  messageTs: string;
  /** Slack id of the person who clicked. */
  userId: string;
  /** Key Value key of the stored note. */
  noteKey: string;
  /** Slack URL for answering the clicker privately. */
  responseUrl: string;
}

/** Why a click produced no repost. */
export type RepostRefusal =
  | "no-token"
  | "no-note"
  | "not-in-channel"
  | "no-repost-channel"
  | "no-authorize-link"
  | "already-reposted"
  | "repost-in-flight";

export interface RepostResult {
  reposted: boolean;
  reason?: RepostRefusal;
  /** The reposted parent's `ts` in the repost channel. */
  threadTs?: string;
}

export interface RepostDeps {
  /** Used for the `response_url` posts, which are not Slack API calls. */
  fetchImpl?: ResponseFetch;
  now?: () => Date;
}

/**
 * The `error` code inside a thrown Slack failure.
 *
 * `@render-lab/tasks-slack` 0.3.0 throws a plain `Error` and exposes no
 * structured code, so the code has to come out of the message, which it builds
 * as `Slack API ${method} error: ${code}`. Unanchored, because a task that
 * fails under `ctx.run` reaches this as `Subtask failed: ${details}` with the
 * vendor's message inside. The code class is `[a-z_]+`, so a wrapper's trailing
 * quote or punctuation does not become part of it.
 */
const SLACK_ERROR_CODE = /Slack API \S+ error: ([a-z_]+)/;

/**
 * Whether a thrown Slack error carries a given `error` code.
 *
 * Compares the parsed code exactly. A substring test over the whole message
 * would take the branch on any message that merely contains the code, including
 * a note's own text quoted back in a failure.
 */
function isSlackError(err: unknown, code: string): boolean {
  if (!(err instanceof Error)) return false;
  return SLACK_ERROR_CODE.exec(err.message)?.[1] === code;
}

/**
 * Raw implementation of amplifier.repost.
 *
 * The clicker's own user token posts the thread, so the repost reads as theirs
 * and not as the bot's. Everything in the source channel — the reaction and the
 * "Reposted by" reply — uses the bot token, because the clicker never needs
 * write access to a channel they only clicked in.
 */
export async function repostImpl(
  ctx: TaskContext,
  input: RepostInput,
  env: NodeJS.ProcessEnv = process.env,
  deps: RepostDeps = {},
): Promise<RepostResult> {
  const config = loadConfig({}, env);
  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const reply = (text: string) => respondEphemeral(input.responseUrl, text, deps.fetchImpl);

  // Hoisted, because the narrowing does not survive into the closure below.
  const repostChannel = config.repostChannel;
  if (!repostChannel) {
    await reply(
      "Reposting is not set up. Ask the amplifier owner to set AMPLIFIER_REPOST_CHANNEL.",
    );
    return { reposted: false, reason: "no-repost-channel" };
  }

  /** The answer to a click on a note that already has its reposted marker. */
  const alreadyReposted = async (): Promise<RepostResult> => {
    await reply(`Somebody already reposted this note to #${repostChannel}.`);
    return { reposted: false, reason: "already-reposted" };
  };

  // Read before the user token, so a click on a note somebody already reposted
  // is answered with that and not with an authorize link for a repost that will
  // not happen. `claimNote` re-reads this marker under the lock, which is the
  // read that decides.
  const { value: reposted } = await ctx.run(kvGet, { key: repostedKey(input.noteKey) });
  if (reposted !== null) return alreadyReposted();

  const { value: userToken } = await ctx.run(kvGet, { key: userTokenKey(input.userId) });
  if (userToken === null) {
    return {
      reposted: false,
      reason: await sendAuthorizeLink(input, config.slackClientId, env, nowMs, reply),
    };
  }

  const note = await readNote(ctx, input.noteKey);
  if (note === null) {
    await reply(
      `${noStoredNoteMessage("repost", config.seenTtlSeconds)} Copy the links across by hand.`,
    );
    return { reposted: false, reason: "no-note" };
  }

  const parent = { ...withoutNoteActions(note.parent), channel: repostChannel };
  const replies = note.replies.map((r) => ({ ...r, channel: repostChannel }));

  if (config.dryRun) {
    log.info(`[dry run] would repost to #${repostChannel} as ${input.userId}`);
    return { reposted: false };
  }

  // Claimed before anything is posted, because the button stays live and a
  // signature is valid for five minutes: a double-click and a replay of one
  // captured click both arrive as two runs, and the receiver answers 200 and
  // dispatches, so nothing upstream collapses them.
  const outcome = await claimNote(ctx, input.noteKey, runToken());
  if (!isRepostClaimed(outcome)) {
    // "reposted" means the marker was written between the unlocked read above
    // and the lock.
    if (outcome.reason === "reposted") return alreadyReposted();
    await reply(
      `This note is being reposted to #${repostChannel} right now. Check the channel in a ` +
        `few minutes, and click again if nothing landed.`,
    );
    return { reposted: false, reason: "repost-in-flight" };
  }

  let threadTs: string | undefined;
  try {
    ({ ts: threadTs } = await ctx.run(postNote, { ...parent, userToken }));
  } catch (err) {
    if (!isSlackError(err, "not_in_channel")) {
      // The claim is kept, not released: `chat.postMessage` is not idempotent
      // and Slack may have accepted a post it then failed to report, so the
      // retry is given up rather than risking a second thread. The lock expires
      // in INFLIGHT_TTL_SECONDS and the button works again after that.
      log.error(
        `[amplifier] The repost of ${input.noteKey} failed on the parent post, so the claim ` +
          `is held and further clicks are refused until it expires.`,
        err,
      );
      throw err;
    }
    await releaseClaim(ctx, outcome.claim);
    await reply(
      `Join #${repostChannel} and click Repost again — Slack will not post you into a ` +
        `channel you are not in.`,
    );
    return { reposted: false, reason: "not-in-channel" };
  }

  await postReplies(
    ctx,
    replies.map((r) => ({ ...r, userToken })),
    threadTs,
    (err) => log.error("[amplifier] A reposted thread is missing one of its links.", err),
  );

  await markSource(ctx, input, config.repostEmoji, config.seenTtlSeconds);
  await reply(`Reposted to #${repostChannel}.`);
  return { reposted: true, ...(threadTs ? { threadTs } : {}) };
}

/**
 * Send the one-time authorize link.
 *
 * Nobody is onboarded in advance, so the first click is what asks for the
 * token. A missing client id or public URL is the deployment's problem and not
 * the clicker's, so the message says who to ask.
 */
async function sendAuthorizeLink(
  input: RepostInput,
  clientId: string | undefined,
  env: NodeJS.ProcessEnv,
  nowMs: number,
  reply: (text: string) => Promise<void>,
): Promise<RepostRefusal> {
  log.info(`[amplifier] No stored Slack token for ${input.userId}; sending the authorize link.`);
  const secret = env.SLACK_SIGNING_SECRET?.trim();
  const base = publicBaseUrl(env);
  if (!clientId || !secret || !base) {
    await reply(
      "Reposting needs a one-time authorization, but this deployment has no authorize link. " +
        "Ask the amplifier owner to set SLACK_CLIENT_ID, SLACK_SIGNING_SECRET and " +
        "AMPLIFIER_PUBLIC_URL.",
    );
    return "no-authorize-link";
  }
  const url = authorizeUrl({
    clientId,
    redirectUri: `${base}${CALLBACK_PATH}`,
    state: signState(input.userId, secret, nowMs),
  });
  await reply(
    `Authorize amplifier to post as you once, then click Repost again: <${url}|Authorize>`,
  );
  return "no-token";
}

/**
 * Mark the source thread as reposted: a Key Value marker, a reaction on the
 * parent, and a reply naming who did it.
 *
 * No failure here stops the run. The repost is already posted, so a missing
 * reaction is cosmetic, and throwing would retry the whole task and post the
 * thread a second time. A missing marker only costs a reminder for a note that
 * has in fact been reposted.
 *
 * The marker carries the seen TTL, so it expires with the stored note and the
 * announced marker.
 */
async function markSource(
  ctx: TaskContext,
  input: RepostInput,
  emoji: string,
  ttlSeconds: number,
): Promise<void> {
  try {
    await ctx.run(kvSet, {
      key: repostedKey(input.noteKey),
      value: "reposted",
      ttlSeconds,
    });
  } catch (err) {
    log.error(
      "[amplifier] Could not record this note as reposted, so it may still get a reminder.",
      err,
    );
  }
  try {
    await ctx.run(addReaction, { channel: input.channel, ts: input.messageTs, emoji });
  } catch (err) {
    // Slack answers `already_reacted` on a repeat click, which is the state
    // this was trying to reach.
    if (!isSlackError(err, "already_reacted")) {
      log.error(`[amplifier] Could not add :${emoji}: to the reposted note.`, err);
    }
  }
  try {
    await ctx.run(postNote, {
      channel: input.channel,
      text: "Reposted",
      markdown: `Reposted by <@${input.userId}>`,
      threadTs: input.messageTs,
    });
  } catch (err) {
    log.error("[amplifier] Could not post the Reposted-by reply in the source thread.", err);
  }
}

/**
 * Repost an announcement thread into the repost channel, as the clicker.
 *
 * REPOST_RETRY is short because a person is waiting on the ephemeral answer. A
 * retry can only fire before the parent is posted: everything after it either
 * swallows its own failure or answers the clicker and returns.
 *
 * The claim is held and not released once the parent is posted. The reposted
 * marker takes over from it, and the lock expiring is what lets a note be
 * reposted again after a run died mid-thread.
 */
export const repost = task({ name: "amplifier.repost", retry: REPOST_RETRY }, repostImpl);
