import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { set as kvSet } from "@render-lab/tasks-render-kv";
import { loadConfig } from "../config.js";
import { userTokenKey } from "../slack/oauth.js";
import type { ResponseFetch } from "../slack/respond.js";
import * as log from "../log.js";

export interface SaveUserTokenInput {
  /** The single-use code Slack put on the callback URL. */
  code: string;
  /** The user id the signed `state` carried. */
  userId: string;
  /** The same redirect_uri the authorize link used. Slack checks it matches. */
  redirectUri: string;
}

export interface SaveUserTokenResult {
  saved: boolean;
  /** Set when nothing was saved, naming why. */
  error?: string;
}

export interface SaveUserTokenDeps {
  fetchImpl?: ResponseFetch;
}

interface AccessResponse {
  ok?: boolean;
  error?: string;
  authed_user?: { id?: string; access_token?: string };
}

/**
 * Raw implementation of amplifier.saveUserToken.
 *
 * Exchanges the code at `oauth.v2.access` and stores
 * `authed_user.access_token` with no expiry, so one authorization lasts until
 * the person or the workspace revokes it.
 *
 * Every failure is returned rather than thrown, because the caller is the OAuth
 * callback and the browser needs a page explaining what went wrong.
 */
export async function saveUserTokenImpl(
  ctx: TaskContext,
  input: SaveUserTokenInput,
  env: NodeJS.ProcessEnv = process.env,
  deps: SaveUserTokenDeps = {},
): Promise<SaveUserTokenResult> {
  const { slackClientId: clientId, slackClientSecret: clientSecret } = loadConfig({}, env);
  if (!clientId || !clientSecret) {
    return { saved: false, error: "SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are not both set." };
  }

  const doFetch = deps.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  const res = await doFetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: body.toString(),
  });
  const text = await res.text();
  let data: AccessResponse;
  try {
    data = JSON.parse(text) as AccessResponse;
  } catch {
    return { saved: false, error: `Slack answered ${res.status} with a body that is not JSON.` };
  }
  if (!data.ok) {
    return { saved: false, error: `Slack rejected the exchange: ${data.error ?? "unknown"}.` };
  }

  const token = data.authed_user?.access_token;
  const authedUserId = data.authed_user?.id;
  if (!token || !authedUserId) {
    return { saved: false, error: "Slack returned no user token. Check the app's user scopes." };
  }
  // The id from the signed state and the id Slack authorized have to be the
  // same person, or the token would be stored under someone else's id.
  if (authedUserId !== input.userId) {
    return {
      saved: false,
      error: `Slack authorized ${authedUserId} but the link was issued to ${input.userId}.`,
    };
  }

  await ctx.run(kvSet, { key: userTokenKey(input.userId), value: token });
  log.info(`[amplifier] Stored a Slack user token for ${input.userId}.`);
  return { saved: true };
}

/**
 * Exchange an OAuth code for one person's Slack user token and store it.
 *
 * No retry policy. An OAuth code is single-use, so a retry after a successful
 * exchange fails with `invalid_code` and turns a working authorization into a
 * reported failure.
 */
export const saveUserToken = task({ name: "amplifier.saveUserToken" }, saveUserTokenImpl);
