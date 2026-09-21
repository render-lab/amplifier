import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { deleteKeys, get as kvGet, lock, set as kvSet } from "@render-lab/tasks-render-kv";
import { loadConfig, type AmplifierConfig } from "../config.js";
import { getPage } from "../notion/getPage.js";
import { readLaunch } from "../notion/launch.js";
import { isLaunch, type Launch, type Owner } from "../notion/types.js";
import { isResolved } from "../slack/api.js";
import { lookupUser, openDm } from "../slack/lookupUser.js";
import { messageLink } from "../slack/permalink.js";
import { postNote } from "../slack/postNote.js";
import { resolveLaunchPageId } from "./launchPage.js";
import { pingedKey, pingInflightKey } from "./pinged.js";
import { ownerLabel, renderPingDm } from "./pingTemplate.js";
import { INFLIGHT_TTL_SECONDS, releaseClaim, runToken } from "./seen.js";
import * as log from "../log.js";

export interface PingOwnersInput {
  /** Notion page id from the webhook, or pasted in for a manual run. */
  pageId?: string;
  /**
   * Permalink to the live post, or its Typefully share URL. Searches the
   * launch database for the page carrying that link. Needs NOTION_DATABASE_ID.
   */
  url?: string;
  /** Typefully draft id, searched the same way as url. */
  draftId?: string;
  /**
   * Channel the announcement thread is in. Both this and `noteTs` are read off
   * the thread's Slack message link; without them nobody is DMed.
   */
  noteChannel?: string;
  /** The announcement parent's `ts`, which the DM links to. */
  noteTs?: string;
  /** Ping a page the marker already records. Re-sends the DMs. */
  force?: boolean;
  dryRun?: boolean;
}

/** One owner the run could not DM, and the reason in words. */
export interface UnreachableOwner {
  owner: Owner;
  /** Why no DM went out, such as `no Slack account for name@render.com`. */
  reason: string;
}

/** One owner the run DM'd. */
export interface PingedOwner {
  name?: string;
  email?: string;
  /** false in dry run, and false when the Slack port reported no delivery. */
  delivered: boolean;
}

export interface PingOwnersResult {
  pageId: string;
  dryRun: boolean;
  /** Set when no DM was sent, naming why. */
  skipped?: "no-url" | "no-owners" | "other-database" | "pinged" | "claimed" | "no-thread";
  /** One entry per owner a DM was addressed to. */
  pinged?: PingedOwner[];
  /** Owners with no DM, and why. Logged, never posted to Slack. */
  unreachable?: UnreachableOwner[];
}

/** One owner's DM as the result reports it, naming them when Notion did. */
function pingedOwner(owner: Owner, email: string, delivered: boolean): PingedOwner {
  return { ...(owner.name ? { name: owner.name } : {}), email, delivered };
}

/**
 * DM one owner, or say why not.
 *
 * Email, then Slack user id, then DM channel, then the message. Every step can
 * answer "no" about this one person without ending the run, because the other
 * owners' DMs have already gone out or are still to go.
 */
async function pingOwner(
  ctx: TaskContext,
  launch: Launch,
  owner: Owner,
  noteUrl: string,
  config: AmplifierConfig,
): Promise<PingedOwner | UnreachableOwner> {
  const email = owner.email?.trim();
  if (!email) {
    return {
      owner,
      reason:
        "the Notion page carries no email for them, which is also what a Notion " +
        "integration without the user-email capability looks like",
    };
  }

  const found = await ctx.run(lookupUser, { email });
  if (!isResolved(found)) {
    return { owner, reason: `Slack answered \`${found.error}\` for ${email}` };
  }

  const dm = await ctx.run(openDm, { userId: found.userId });
  if (!isResolved(dm)) {
    return { owner, reason: `Slack answered \`${dm.error}\` opening a DM with ${email}` };
  }

  const message = renderPingDm(launch, { channel: dm.channelId, noteUrl, ask: config.pingAsk });
  if (config.dryRun) {
    log.info(`[dry run] would DM ${ownerLabel(owner)}:\n${message.markdown}`);
    return pingedOwner(owner, email, false);
  }

  try {
    const posted = await ctx.run(postNote, message);
    return pingedOwner(owner, email, posted.delivered);
  } catch (err) {
    // The DM is already past SLACK_RETRY, so this is a lasting failure for one
    // person. Logged rather than thrown, so the owners who did get a DM are
    // not DM'd twice by the next delivery.
    const detail = err instanceof Error ? err.message : String(err);
    return { owner, reason: `the DM to ${email} failed: ${detail}` };
  }
}

/**
 * The permalink to the announcement thread, or undefined once it has said why
 * there is none.
 *
 * A DM telling somebody to click a button in a thread it cannot name is worse
 * than no DM, so a missing channel and `ts`, and a Slack error, both end the
 * run here.
 */
async function threadLink(
  ctx: TaskContext,
  pageId: string,
  input: PingOwnersInput,
): Promise<string | undefined> {
  const channel = input.noteChannel?.trim();
  const messageTs = input.noteTs?.trim();
  if (!channel || !messageTs) {
    log.error(
      `[amplifier] No announcement thread for page ${pageId}, so nobody is DMed. Pass ` +
        `noteChannel and noteTs, both readable from the thread's Slack message link.`,
    );
    return undefined;
  }

  const link = await ctx.run(messageLink, { channel, messageTs });
  if (!isResolved(link)) {
    log.error(
      `[amplifier] Slack answered \`${link.error}\` for the thread ${channel}/${messageTs} on ` +
        `page ${pageId}, so nobody is DMed.`,
    );
    return undefined;
  }
  return link.url;
}

/** Whether `pingOwner` sent, or tried to send, a DM. */
function isPinged(outcome: PingedOwner | UnreachableOwner): outcome is PingedOwner {
  return !("reason" in outcome);
}

/**
 * Log the owners nobody could DM.
 *
 * The reasons stay in the logs and in the run's result, because a note in the
 * channel notifies everyone in it about a DM that did not send.
 */
function logUnreachable(pageId: string, unreachable: UnreachableOwner[]): void {
  for (const { owner, reason } of unreachable) {
    log.error(`[amplifier] No DM for ${ownerLabel(owner)} on page ${pageId}: ${reason}`);
  }
}

/** Raw implementation of amplifier.pingOwners. */
export async function pingOwnersImpl(
  ctx: TaskContext,
  input: PingOwnersInput = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<PingOwnersResult> {
  if (!input.pageId?.trim() && !input.url && input.draftId === undefined) {
    throw new Error(
      "Pass the Notion page id as pageId, or the post's permalink as url, or its Typefully id " +
        "as draftId.",
    );
  }

  const config = loadConfig(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}, env);

  // A URL reaches the page the long way round: Typefully turns the permalink
  // into the draft's share URL, and that share URL is the link on the page.
  const pageId =
    input.pageId?.trim() ||
    (await resolveLaunchPageId(
      ctx,
      {
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.draftId !== undefined ? { draftId: input.draftId } : {}),
      },
      config,
    ));

  // Marker, then lock, then the work, then the marker again — the order
  // `announceGroups` uses. The announce path runs this after every note it
  // posts, so a re-announced draft re-enters it, and the marker is what keeps
  // the owners from being DMed twice.
  const marker = pingedKey(pageId);
  const { value } = await ctx.run(kvGet, { key: marker });
  if (value !== null) {
    if (!input.force) {
      log.info(
        `[amplifier] Page ${pageId} was already pinged. Pass force: true to DM its owners again.`,
      );
      return { pageId, dryRun: config.dryRun, skipped: "pinged" };
    }
    await ctx.run(deleteKeys, { keys: [marker] });
    log.info(`[amplifier] Cleared the pinged marker for page ${pageId}.`);
  }

  const lockKey = pingInflightKey(pageId);
  const token = runToken();
  const { acquired } = await ctx.run(lock, {
    key: lockKey,
    token,
    ttlSeconds: INFLIGHT_TTL_SECONDS,
  });
  if (!acquired) {
    // Another delivery of the same property edit is pinging this page now.
    return { pageId, dryRun: config.dryRun, skipped: "claimed" };
  }

  try {
    const { page } = await ctx.run(getPage, { pageId });
    const outcome = readLaunch(page, {
      typefullyProperty: config.notionTypefullyProperty,
      ownersProperty: config.notionOwnersProperty,
      ...(config.notionDatabaseId ? { databaseId: config.notionDatabaseId } : {}),
    });
    if (!isLaunch(outcome)) {
      log.info(`[amplifier] Page ${pageId} is not ready to ping: ${outcome.skip}.`);
      return { pageId, dryRun: config.dryRun, skipped: outcome.skip };
    }

    const noteUrl = await threadLink(ctx, pageId, input);
    if (noteUrl === undefined) {
      // No pinged marker, so a later run with the thread's channel and `ts`
      // can still DM these owners.
      return { pageId, dryRun: config.dryRun, skipped: "no-thread" };
    }

    const pinged: PingedOwner[] = [];
    const unreachable: UnreachableOwner[] = [];
    // Sequential, so the owners are DM'd in the order the property lists them
    // and one slow lookup cannot open every DM at once.
    for (const owner of outcome.owners) {
      const result = await pingOwner(ctx, outcome, owner, noteUrl, config);
      if (isPinged(result)) pinged.push(result);
      else unreachable.push(result);
    }

    logUnreachable(pageId, unreachable);

    // Only after Slack accepted a DM, so a page whose owners were all
    // unreachable is pinged again by the next announcement. The marker is
    // separate from the lock, so a lock left behind by a crashed run never
    // reads as a ping that went out.
    if (pinged.some((p) => p.delivered)) {
      await ctx.run(kvSet, { key: marker, value: "pinged", ttlSeconds: config.seenTtlSeconds });
    }

    return {
      pageId,
      dryRun: config.dryRun,
      pinged,
      ...(unreachable.length > 0 ? { unreachable } : {}),
    };
  } finally {
    await releaseClaim(ctx, { key: lockKey, token });
  }
}

/**
 * DM a launch's owners the link to its announcement thread.
 *
 * Takes the Notion page id, or a live post's permalink, which it turns into a
 * page id through Typefully's share URL. `announceGroups` runs it after every
 * announcement; a manual run needs `noteChannel` and `noteTs` as well.
 *
 * No retry policy, matching `amplifier.announcePost`. A DM that failed to send
 * is better re-run by hand than re-sent on a schedule.
 */
export const pingOwners = task({ name: "amplifier.pingOwners" }, pingOwnersImpl);
