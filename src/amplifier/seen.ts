import { randomUUID } from "node:crypto";
import type { TaskContext } from "@renderinc/sdk/workflows";
import { get as kvGet, lock, set as kvSet, unlock } from "@render-lab/tasks-render-kv";
import type { PostGroup } from "./group.js";
import * as log from "../log.js";

/** A Key Value in-flight lock this run holds on one draft. */
export interface Claim {
  key: string;
  token: string;
}

/**
 * How long an in-flight lock survives without being released. A run that dies
 * between the lock and the Slack post leaves the lock behind, so the TTL is
 * short enough that the next run retries the draft, whether that is an
 * `amplifier.handleEvent` retry or a manual re-run.
 */
export const INFLIGHT_TTL_SECONDS = 300;

/**
 * A token identifying one run's locks, unique per invocation and stable within
 * it.
 *
 * The SDK 1.0 TaskContext exposes no run id, and an in-flight lock only has to
 * tell this run's lock from another run's.
 */
export function runToken(): string {
  return `amplifier:run:${randomUUID()}`;
}

/** Key that records a draft as announced. Written after Slack accepts the note. */
export function seenKey(draftId: string): string {
  return `amplifier:seen:${draftId}`;
}

/** Key one run holds while it is announcing a draft. */
export function inflightKey(draftId: string): string {
  return `amplifier:inflight:${draftId}`;
}

/**
 * Which of these drafts an earlier run already announced.
 *
 * Read this before grouping. Group membership depends on what Typefully
 * returned on this run, so it is not stable across runs and cannot be the unit
 * of dedupe. A draft is.
 *
 * The reads are independent, so they are dispatched together. Each `ctx.run`
 * polls its own subtask every 500ms, and 25 sequential reads would wait
 * through 25 of those intervals.
 */
export async function announcedDraftIds(
  ctx: TaskContext,
  draftIds: string[],
): Promise<Set<string>> {
  const marks = await Promise.all(
    draftIds.map(async (draftId) => {
      const { value } = await ctx.run(kvGet, { key: seenKey(draftId) });
      return { draftId, announced: value !== null };
    }),
  );
  return new Set(marks.filter((m) => m.announced).map((m) => m.draftId));
}

/**
 * Why a group was not claimed.
 *
 * `announced` means an earlier run finished announcing that draft while this
 * run was reading the markers. `in-flight` means another run holds the lock and
 * is announcing that draft right now. Both mean this run must not post the
 * group, and both leave every unannounced draft in it without a marker, so the
 * next run regroups what is left and announces it.
 */
export interface ClaimRefusal {
  reason: "announced" | "in-flight";
  draftId: string;
}

export type ClaimOutcome = { claims: Claim[] } | ClaimRefusal;

/** Whether `claimGroup` handed back locks. */
export function isClaimed(outcome: ClaimOutcome): outcome is { claims: Claim[] } {
  return "claims" in outcome;
}

/**
 * Take an in-flight lock on every draft in the group, or nothing.
 *
 * `token` is unique per run, so a failed `kv.lock` always means another run.
 * The announced marker is re-read after each lock is acquired, because
 * `announcedDraftIds` runs before the first lock attempt and another run can
 * announce the draft in between. Locks already taken are released before giving
 * up.
 */
export async function claimGroup(
  ctx: TaskContext,
  group: PostGroup,
  token: string,
  ttlSeconds: number = INFLIGHT_TTL_SECONDS,
): Promise<ClaimOutcome> {
  const claims: Claim[] = [];

  for (const draftId of group.draftIds) {
    const key = inflightKey(draftId);
    const { acquired } = await ctx.run(lock, { key, token, ttlSeconds });
    if (!acquired) {
      await releaseGroup(ctx, claims);
      return { reason: "in-flight", draftId };
    }
    claims.push({ key, token });

    const { value } = await ctx.run(kvGet, { key: seenKey(draftId) });
    if (value !== null) {
      await releaseGroup(ctx, claims);
      return { reason: "announced", draftId };
    }
  }

  return { claims };
}

/**
 * Record every draft in the group as announced, with the 30-day TTL.
 *
 * Call this only after `amplifier.postNote` reports the note delivered. The
 * marker is separate from the in-flight lock, so a lock left behind by a
 * crashed run never reads as a completed announcement.
 *
 * One `kv.set` per draft, so a failure leaves some drafts marked and some not.
 * The caller releases the locks and the next run announces the unmarked drafts
 * as their own group.
 */
export async function markAnnounced(
  ctx: TaskContext,
  draftIds: string[],
  ttlSeconds: number,
): Promise<void> {
  await Promise.all(
    draftIds.map((draftId) =>
      ctx.run(kvSet, { key: seenKey(draftId), value: "announced", ttlSeconds }),
    ),
  );
}

/**
 * Release one in-flight lock, whatever it covers.
 *
 * A failed unlock is logged, not thrown. The lock expires on its own after
 * `INFLIGHT_TTL_SECONDS`, so releasing it early only brings the next run's
 * retry forward, and a caller that is already throwing must not lose its error
 * to a cleanup failure.
 */
export async function releaseClaim(ctx: TaskContext, claim: Claim): Promise<void> {
  try {
    await ctx.run(unlock, { key: claim.key, token: claim.token });
  } catch (err) {
    log.error(
      `[amplifier] Could not release the in-flight lock ${claim.key}. It expires in ` +
        `${INFLIGHT_TTL_SECONDS}s and the next run retries what it covers.`,
      err,
    );
  }
}

/** Release in-flight locks so a later run can announce these drafts. */
export async function releaseGroup(ctx: TaskContext, claims: Claim[]): Promise<void> {
  await Promise.all(claims.map((claim) => releaseClaim(ctx, claim)));
}
