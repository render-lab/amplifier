import type { FetchLike } from "@render-lab/tasks-core";
import { checkedBaseUrl } from "../http/baseUrl.js";

/** Where `webApiPort` sends every call, and what SLACK_API_BASE_URL replaces. */
export const SLACK_API_BASE_URL = "https://slack.com/api";

/**
 * The Slack host to send the bot token to.
 *
 * SLACK_API_BASE_URL redirects a call to a local stub, the way
 * TYPEFULLY_BASE_URL does for Typefully. Only a loopback address is accepted,
 * because the bot token — and, on a repost, the clicker's user token — travels
 * to whatever host it names.
 */
export function slackBaseUrl(env: NodeJS.ProcessEnv): string {
  return checkedBaseUrl(env.SLACK_API_BASE_URL, {
    name: "SLACK_API_BASE_URL",
    realBaseUrl: SLACK_API_BASE_URL,
    credential: "SLACK_BOT_TOKEN",
  });
}

/**
 * One form field's value.
 *
 * Objects are excluded because the body is form-encoded: `views.open` and
 * `chat.update` JSON-encode their `view` and `blocks` before the call, and
 * passing the object itself would send the string "[object Object]".
 */
export type SlackFormValue = string | number | boolean | null | undefined;

/** A Web API reply, as far as the callers here read it. */
export interface SlackApiResponse {
  ok?: boolean;
  /** Slack's error code, such as `users_not_found`. Present when `ok` is false. */
  error?: string;
  [field: string]: unknown;
}

/**
 * Whether a Slack result carries what it was asked for.
 *
 * Every task over this client answers `{ error }` for an `ok: false` body — a
 * `users_not_found` is a fact about a person, not a transport failure — so the
 * guard is shared rather than written once per result type.
 */
export function isResolved<T extends object>(result: T | { error: string }): result is T {
  return !("error" in result);
}

/**
 * Call one Web API method with the bot token and hand back the parsed body.
 *
 * `@render-lab/tasks-slack` 0.3.0's `SlackWebPort` covers posting, reactions
 * and history but neither `users.lookupByEmail` nor `conversations.open`, so
 * these two methods go over their own client. It throws on a non-2xx, which is
 * what fires the durable retry, and returns `ok: false` bodies to the caller:
 * `users_not_found` is an answer about a person, not a transport failure.
 *
 * The body is form-encoded. `users.lookupByEmail` reads no JSON body and
 * answers `invalid_arguments` with "missing required field: email" when it is
 * sent one.
 */
export async function callSlack(
  method: string,
  body: Record<string, SlackFormValue>,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): Promise<SlackApiResponse> {
  const env = opts.env ?? process.env;
  const token = env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error(`SLACK_BOT_TOKEN is unset, so ${method} cannot be called.`);
  }

  const form = new URLSearchParams();
  for (const [field, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) form.set(field, String(value));
  }

  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const res = await fetchImpl(`${slackBaseUrl(env)}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: form.toString(),
  });
  if (!res.ok) {
    throw new Error(`Slack API ${method} answered ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as SlackApiResponse;
}
