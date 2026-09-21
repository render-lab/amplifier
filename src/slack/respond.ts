import * as log from "../log.js";

/** The fetch shape the response-url helper needs, so a test can pass a fake. */
export type ResponseFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Answer a block action privately, through the `response_url` Slack sent.
 *
 * `response_url` takes a plain JSON POST with no token, which is the only way
 * to reach one person in a channel the bot may not be in. A failure is logged
 * and swallowed: the repost itself has already happened by then, and losing the
 * confirmation must not fail the run and send the clicker a second thread.
 */
export async function respondEphemeral(
  responseUrl: string,
  text: string,
  fetchImpl: ResponseFetch = fetch as unknown as ResponseFetch,
): Promise<void> {
  try {
    const res = await fetchImpl(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
    });
    if (!res.ok) {
      log.error(`[amplifier] Slack rejected a response_url post with ${res.status}.`);
    }
  } catch (err) {
    log.error("[amplifier] Could not answer a Repost click through its response_url.", err);
  }
}
