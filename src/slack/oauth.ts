import { createHmac } from "node:crypto";
import { timingSafeEquals } from "../http/signature.js";

/** Key a person's Slack user token is stored under. No TTL; see the README. */
export function userTokenKey(userId: string): string {
  return `amplifier:slack:user:${userId}`;
}

/** The only scope a stakeholder grants: post as themselves. */
const USER_SCOPE = "chat:write";

/** Path the Slack app redirects to after a person authorizes. */
export const CALLBACK_PATH = "/slack/oauth/callback";

/** How long an authorize link stays usable. Long enough to read the message and click. */
const STATE_TTL_MS = 10 * 60_000;

/**
 * Sign the clicker's id into the OAuth `state`.
 *
 * Without a signature anyone could complete the callback with a `state` they
 * wrote themselves and have their token stored under someone else's id. The
 * expiry keeps an old authorize link from being replayed.
 */
export function signState(userId: string, secret: string, nowMs: number): string {
  const payload = `${userId}:${nowMs + STATE_TTL_MS}`;
  const mac = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}:${mac}`;
}

/** Why a `state` was not accepted. */
export type StateFailure = "malformed" | "bad-signature" | "expired";

export type StateOutcome = { userId: string } | { failure: StateFailure };

/** Whether `verifyState` recognized the state. */
export function isVerified(outcome: StateOutcome): outcome is { userId: string } {
  return "userId" in outcome;
}

/** Read the user id back out of a `state`, rejecting anything unsigned or stale. */
export function verifyState(state: string, secret: string, nowMs: number): StateOutcome {
  const parts = state.split(":");
  if (parts.length !== 3) return { failure: "malformed" };
  const [userId, expiresAt, mac] = parts as [string, string, string];
  if (userId === "" || !/^\d+$/.test(expiresAt)) return { failure: "malformed" };

  const expected = createHmac("sha256", secret).update(`${userId}:${expiresAt}`).digest("hex");
  if (!timingSafeEquals(expected, mac)) return { failure: "bad-signature" };
  if (nowMs > Number(expiresAt)) return { failure: "expired" };
  return { userId };
}

/**
 * The link that asks one person for a user token.
 *
 * `user_scope` and not `scope`, so the install is not re-negotiated and only
 * `authed_user.access_token` comes back.
 */
export function authorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    user_scope: USER_SCOPE,
    redirect_uri: opts.redirectUri,
    state: opts.state,
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

/**
 * The receiver's own public base URL.
 *
 * Render sets RENDER_EXTERNAL_URL on the receiver, so the callback route needs
 * nothing else. The Workflow service has no external URL of its own, so
 * `amplifier.repost` needs AMPLIFIER_PUBLIC_URL set to the receiver's host to
 * build the authorize link. It is also how the callback runs locally.
 */
export function publicBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const base = env.AMPLIFIER_PUBLIC_URL?.trim() || env.RENDER_EXTERNAL_URL?.trim();
  return base ? base.replace(/\/+$/, "") : undefined;
}
