import { createDispatchServer, type WorkflowDispatcher } from "@render-lab/triggers";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { record } from "./json.js";
import {
  CALLBACK_PATH,
  isVerified,
  publicBaseUrl,
  verifyState,
  type StateFailure,
} from "./slack/oauth.js";
import {
  parseEditClick,
  parseEditSubmit,
  parseRepostClick,
  verifySlackSignature,
} from "./slack/interactivity.js";
import { editView, LEAD_BLOCK_ID } from "./slack/editModal.js";
import { respondEphemeral } from "./slack/respond.js";
import { openView } from "./slack/views.js";
import { typefullyWebhook } from "./typefully/webhook.js";
import * as log from "./log.js";

export interface ReceiverOptions {
  dispatcher: WorkflowDispatcher;
  workflowSlug: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** How long the OAuth callback waits for the token exchange before giving up. */
const EXCHANGE_TIMEOUT_MS = 20_000;

/**
 * Cap for the routes `createDispatchServer` registers, passed to it explicitly
 * so this service does not inherit whatever the vendor's default becomes.
 */
const MAX_DISPATCH_BODY_BYTES = 1_048_576;

/**
 * Cap for Slack interactivity, tighter because the payload is a known shape. A
 * real Repost click measures about 2 KB form-encoded, note blocks included, so
 * this leaves room for a much longer note and still bounds what one unsigned
 * request holds in memory.
 */
const MAX_INTERACTIVITY_BYTES = 65_536;

/**
 * The receiver's HTTP app: the dispatch server plus the two Slack routes.
 *
 * `createDispatchServer` rather than `serveDispatchServer`, because the Slack
 * routes mount on the Hono app it returns. They cannot be `WebhookAdapter`s:
 * Slack sends interactivity as form-encoded with the JSON in a `payload` field,
 * and the adapter path `JSON.parse`s the body before `map` ever sees it.
 */
export function buildReceiver(opts: ReceiverOptions): Hono {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const app = createDispatchServer({
    workflowSlug: opts.workflowSlug,
    dispatcher: opts.dispatcher,
    webhooks: { typefully: typefullyWebhook({ env, now }) },
    maxBodyBytes: MAX_DISPATCH_BODY_BYTES,
  });

  /**
   * Act on a verified interactivity payload: a Repost click, an Edit click, or
   * a submitted edit modal.
   *
   * Answers 200 before the dispatch, because Slack's budget is three seconds
   * and starting a run is slower. The clicker hears the rest through
   * `response_url`. `views.open` is the exception, spending a `trigger_id` that
   * expires inside those same three seconds.
   */
  app.post(
    "/slack/interactivity",
    bodyLimit({
      maxSize: MAX_INTERACTIVITY_BYTES,
      onError: (c) => c.json({ error: "payload too large" }, 413),
    }),
    async (c) => {
      const rawBody = await c.req.text();
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      if (!verifySlackSignature(headers, rawBody, env.SLACK_SIGNING_SECRET, now().getTime())) {
        return c.json({ error: "invalid signature" }, 401);
      }

      const payloadField = new URLSearchParams(rawBody).get("payload");
      if (payloadField === null) return c.json({ error: "no payload" }, 400);
      let payload: unknown;
      try {
        payload = JSON.parse(payloadField);
      } catch {
        return c.json({ error: "invalid payload JSON" }, 400);
      }

      const click = parseRepostClick(payload);
      if (click) {
        void opts.dispatcher.start("amplifier.repost", [click]).catch((err: unknown) => {
          log.error("[amplifier] Could not start amplifier.repost for a Repost click.", err);
        });
        return c.body(null, 200);
      }

      const edit = parseEditClick(payload);
      if (edit) {
        // Awaited rather than dispatched. A `trigger_id` is good for three
        // seconds, so the modal has to open from here.
        const opened = await openView(
          edit.triggerId,
          editView(
            {
              channel: edit.channel,
              messageTs: edit.messageTs,
              noteKey: edit.noteKey,
              responseUrl: edit.responseUrl,
            },
            edit.lead,
          ),
          { env },
        );
        if (!opened.opened) {
          log.error(`[amplifier] Slack refused views.open: ${opened.error}.`);
          await respondEphemeral(
            edit.responseUrl,
            `Slack would not open the edit box: ${opened.error}. Click Edit again.`,
          );
        }
        return c.body(null, 200);
      }

      const submit = parseEditSubmit(payload);
      if (submit) {
        const lead = submit.lead.trim();
        if (lead === "") {
          // `response_action` keeps the modal open with the error under the
          // input, which is the only way to answer a submission inline.
          return c.json(
            { response_action: "errors", errors: { [LEAD_BLOCK_ID]: "Write the note's text." } },
            200,
          );
        }
        void opts.dispatcher
          .start("amplifier.editNote", [{ ...submit.meta, lead }])
          .catch((err: unknown) => {
            log.error("[amplifier] Could not start amplifier.editNote for an edit.", err);
          });
        // An empty body closes the modal.
        return c.json({}, 200);
      }

      return c.body(null, 200);
    },
  );

  /**
   * Finish one person's authorization.
   *
   * Waits for `amplifier.saveUserToken` rather than starting it, so the browser
   * gets a real answer instead of a page that says "probably".
   */
  app.get(CALLBACK_PATH, async (c) => {
    const secret = env.SLACK_SIGNING_SECRET;
    if (!secret) return page("Not configured", "SLACK_SIGNING_SECRET is unset.", 500);

    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      const denied = c.req.query("error");
      return page(
        "Not authorized",
        denied ? `Slack said: ${denied}.` : "The link was incomplete.",
        400,
      );
    }

    const outcome = verifyState(state, secret, now().getTime());
    if (!isVerified(outcome)) {
      return page("Not authorized", stateMessage(outcome.failure), 400);
    }

    const base = publicBaseUrl(env);
    if (!base) return page("Not configured", "The receiver has no public URL.", 500);

    let result: unknown;
    try {
      const run = await opts.dispatcher.run(
        "amplifier.saveUserToken",
        [{ code, userId: outcome.userId, redirectUri: `${base}${CALLBACK_PATH}` }],
        EXCHANGE_TIMEOUT_MS,
      );
      if (run.timedOut) {
        return page("Still working", "Slack is slow. Click Repost again in a minute.", 504);
      }
      result = run.results;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return page("Not authorized", `The token exchange failed: ${detail}`, 502);
    }

    const error = exchangeError(result);
    if (error) return page("Not authorized", error, 400);
    return page("Authorized", "Go back to Slack and click Repost again.", 200);
  });

  return app;
}

/** Why a `state` was rejected, in words a person can act on. */
function stateMessage(failure: StateFailure): string {
  if (failure === "expired") return "The authorize link has expired. Click Repost again.";
  return "This authorize link was not issued by amplifier.";
}

/**
 * The error `amplifier.saveUserToken` reported, or undefined on success.
 *
 * The Render API reports a run's results as an array, one entry per argument,
 * and this callback starts the task with one. `results` is typed `unknown`, so
 * the shape is checked rather than asserted.
 */
function exchangeError(results: unknown): string | undefined {
  const result = record(Array.isArray(results) ? results[0] : results);
  if (!result) return "The token exchange returned nothing readable.";
  if (result["saved"] === true) return undefined;
  const error = result["error"];
  return typeof error === "string" ? error : "The token was not saved.";
}

/** A plain HTML page, which is all a browser gets from this receiver. */
function page(title: string, detail: string, status: number): Response {
  const body =
    `<!doctype html><meta charset="utf-8"><title>Amplifier</title>` +
    `<body style="font:16px/1.5 system-ui;margin:4rem auto;max-width:32rem">` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch,
  );
}
