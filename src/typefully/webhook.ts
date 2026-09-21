import { createHmac } from "node:crypto";
import type { WebhookAdapter, WebhookContext, WebhookRequest } from "@render-lab/triggers";
import { isFresh, timingSafeEquals } from "../http/signature.js";
import { nonEmptyString, record } from "../json.js";

/** The one event that can produce a note. */
const PUBLISHED_EVENT = "draft.published";

/** Headers Typefully signs a delivery with, lowercased the way the server hands them over. */
const TIMESTAMP_HEADER = "x-typefully-timestamp";
const SIGNATURE_HEADER = "x-typefully-signature";

/**
 * How far a delivery's timestamp may be from the receiver's clock.
 *
 * Typefully signs the timestamp but never expires it, so without a window a
 * captured delivery stays valid forever. Stripe and Slack both use 5 minutes;
 * this is wider because Typefully retries a failed delivery over an hour and
 * whether it re-signs each attempt is unconfirmed, and a rejected delivery is a
 * post that never gets announced.
 */
const TOLERANCE_MS = 15 * 60_000;

/** The `event` field of a `{ event, data }` envelope, or undefined. */
function eventType(body: unknown): string | undefined {
  return nonEmptyString(record(body)?.["event"]);
}

/** The draft id in the envelope's `data`, as a string, or undefined. */
function draftId(body: unknown): string | undefined {
  const id = record(record(body)?.["data"])?.["id"];
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return nonEmptyString(id);
}

/**
 * The Typefully adapter for `createDispatchServer`.
 *
 * `verify` is the only thing between the receiver's public URL and a workflow
 * run, because `POST /webhooks/:name` does not check `DISPATCH_TOKEN`.
 *
 * `now` is injectable so a test can pin the event time.
 */
export function typefullyWebhook(
  opts: { env?: NodeJS.ProcessEnv; now?: () => Date } = {},
): WebhookAdapter {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());

  return {
    /**
     * Recompute the HMAC-SHA256 over `${timestamp}.${rawBody}`, compare it with
     * `X-Typefully-Signature`, then reject a timestamp outside TOLERANCE_MS.
     *
     * Freshness is checked after the signature so the rejection log only
     * records deliveries that were really signed with the secret.
     *
     * The secret is read on each call rather than at import, matching how
     * `typefullyPort` reads its API key. A missing secret returns false, so an
     * unconfigured receiver rejects deliveries instead of answering 500 to
     * every one of them.
     */
    verify({ headers, rawBody }: WebhookRequest): boolean {
      const secret = env.TYPEFULLY_WEBHOOK_SECRET;
      if (!secret) {
        console.error(
          "[amplifier] TYPEFULLY_WEBHOOK_SECRET is unset, so every delivery is rejected.",
        );
        return false;
      }
      const timestamp = headers[TIMESTAMP_HEADER];
      const signature = headers[SIGNATURE_HEADER];
      if (timestamp === undefined || signature === undefined) return false;

      const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
      if (!timingSafeEquals(`sha256=${digest}`, signature)) return false;
      return isFresh("Typefully", timestamp, now().getTime(), TOLERANCE_MS);
    },

    /**
     * Start a run for a published draft, and ignore everything else.
     *
     * An unrecognized event type maps to null rather than to a run, so a new
     * Typefully event does not start one. `draftId` is omitted when the payload
     * carries no id, which makes the run a plain window rescan because the
     * settle check needs both fields.
     *
     * `eventAt` is stamped at receipt rather than read from the payload. It is
     * stable across every retry of the run because it lives in the args, and it
     * does not depend on Typefully reporting a timestamp.
     */
    map({ body }: WebhookContext) {
      if (eventType(body) !== PUBLISHED_EVENT) return null;
      const id = draftId(body);
      return {
        task: "amplifier.handleEvent",
        args: [{ ...(id !== undefined ? { draftId: id } : {}), eventAt: now().toISOString() }],
      };
    },
  };
}
