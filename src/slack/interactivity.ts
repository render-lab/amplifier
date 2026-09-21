import { createHmac } from "node:crypto";
import type { SlackBlock } from "@render-lab/tasks-slack";
import { isFresh, timingSafeEquals } from "../http/signature.js";
import { nestedId, nonEmptyString, record } from "../json.js";
import { leadOf } from "../amplifier/lead.js";
import { EDIT_ACTION_ID, REPOST_ACTION_ID } from "../amplifier/template.js";
import {
  decodeMeta,
  EDIT_CALLBACK_ID,
  LEAD_ACTION_ID,
  LEAD_BLOCK_ID,
  type EditMeta,
} from "./editModal.js";

/** Headers Slack signs an interactivity delivery with, lowercased. */
const TIMESTAMP_HEADER = "x-slack-request-timestamp";
const SIGNATURE_HEADER = "x-slack-signature";

/** The window Slack documents for its own signature check. */
const TOLERANCE_MS = 5 * 60_000;

/**
 * Whether Slack signed this request with SLACK_SIGNING_SECRET.
 *
 * The signature is HMAC-SHA256 over `v0:{timestamp}:{rawBody}`, so the raw body
 * has to be read before anything parses it.
 *
 * A missing secret returns false, so an unconfigured receiver rejects every
 * request instead of answering 500 to all of them.
 */
export function verifySlackSignature(
  headers: Record<string, string>,
  rawBody: string,
  secret: string | undefined,
  nowMs: number,
): boolean {
  if (!secret) {
    console.error("[amplifier] SLACK_SIGNING_SECRET is unset, so every Slack request is rejected.");
    return false;
  }
  const timestamp = headers[TIMESTAMP_HEADER];
  const signature = headers[SIGNATURE_HEADER];
  if (timestamp === undefined || signature === undefined) return false;

  const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  if (!timingSafeEquals(`v0=${digest}`, signature)) return false;
  return isFresh("Slack", timestamp, nowMs, TOLERANCE_MS);
}

/** An interactivity payload and the button inside it that was clicked. */
interface BlockAction {
  payload: Record<string, unknown>;
  action: Record<string, unknown>;
}

/**
 * The payload and its first action, when that action carries `actionId`.
 *
 * Anything else maps to null, so another interactive element added to the app
 * later neither starts a repost nor opens the edit modal.
 */
function blockAction(payload: unknown, actionId: string): BlockAction | null {
  const p = record(payload);
  if (!p) return null;
  const actions = Array.isArray(p["actions"]) ? p["actions"] : [];
  const action = record(actions[0]);
  if (!action || action["action_id"] !== actionId) return null;
  return { payload: p, action };
}

/** What a Repost click tells the receiver. */
export interface RepostClick {
  /** Channel the clicked note is in. */
  channel: string;
  /** The `ts` of the note the click is about, which is the thread's parent. */
  messageTs: string;
  /** Slack id of the person who clicked. */
  userId: string;
  /** Key Value key of the stored note, carried in the button's `value`. */
  noteKey: string;
  /** Slack URL for posting an ephemeral answer back to the clicker. */
  responseUrl: string;
}

/**
 * Read a Repost click out of an interactivity payload, or null.
 *
 * `messageTs` is the clicked message's `thread_ts`, falling back to its own
 * `ts`. The repost reminder is a reply carrying its own Repost button, and a
 * click on it is about the note at the top of the thread: that is the message
 * the reaction, the "Reposted by" reply and the reposted marker belong on.
 */
export function parseRepostClick(payload: unknown): RepostClick | null {
  const clicked = blockAction(payload, REPOST_ACTION_ID);
  if (!clicked) return null;
  const { payload: p, action } = clicked;

  const channel = nestedId(p, "channel");
  const message = record(p["message"]);
  const messageTs = nonEmptyString(message?.["thread_ts"]) ?? nonEmptyString(message?.["ts"]);
  const userId = nestedId(p, "user");
  const noteKey = nonEmptyString(action["value"]);
  const responseUrl = nonEmptyString(p["response_url"]);
  if (!channel || !messageTs || !userId || !noteKey || !responseUrl) {
    console.error("[amplifier] A Repost click was missing fields the repost task needs.");
    return null;
  }
  return { channel, messageTs, userId, noteKey, responseUrl };
}

/** What an Edit click tells the receiver. */
export interface EditClick {
  channel: string;
  /** The note's `ts`, which is the message the button is in. */
  messageTs: string;
  /** Key Value key of the stored note, carried in the button's `value`. */
  noteKey: string;
  /** Slack's one-shot ticket for opening a modal, good for three seconds. */
  triggerId: string;
  /** Slack URL for answering the editor privately, kept for after the submit. */
  responseUrl: string;
  /** The note's current lead line, which the modal opens prefilled with. */
  lead: string;
}

/**
 * Read an Edit click out of an interactivity payload, or null.
 *
 * Only a note carries the button, so the clicked message is the note and there
 * is no thread to walk. The prefill falls back to the message's `text`, which
 * `renderParent` sets to the lead line.
 */
export function parseEditClick(payload: unknown): EditClick | null {
  const clicked = blockAction(payload, EDIT_ACTION_ID);
  if (!clicked) return null;
  const { payload: p, action } = clicked;

  const channel = nestedId(p, "channel");
  const message = record(p["message"]);
  const messageTs = nonEmptyString(message?.["ts"]);
  const noteKey = nonEmptyString(action["value"]);
  const triggerId = nonEmptyString(p["trigger_id"]);
  const responseUrl = nonEmptyString(p["response_url"]);
  if (!channel || !messageTs || !noteKey || !triggerId || !responseUrl) {
    console.error("[amplifier] An Edit click was missing fields the modal needs.");
    return null;
  }

  const text = nonEmptyString(message?.["text"]) ?? "";
  const blocks = (Array.isArray(message?.["blocks"]) ? message["blocks"] : []) as SlackBlock[];
  const lead = leadOf({ text, blocks }) ?? text;

  return { channel, messageTs, noteKey, triggerId, responseUrl, lead };
}

/** A submitted edit modal. */
export interface EditSubmit {
  meta: EditMeta;
  /** Exactly what was typed. The receiver trims it and rejects a blank. */
  lead: string;
}

/** Read a submitted edit modal, or null. The note comes out of `private_metadata`. */
export function parseEditSubmit(payload: unknown): EditSubmit | null {
  const p = record(payload);
  if (!p || p["type"] !== "view_submission") return null;

  const view = record(p["view"]);
  if (view?.["callback_id"] !== EDIT_CALLBACK_ID) return null;

  const meta = decodeMeta(view["private_metadata"]);
  if (!meta) {
    console.error("[amplifier] An edit submission named no note amplifier could edit.");
    return null;
  }

  const values = record(record(view["state"])?.["values"]);
  const block = record(values?.[LEAD_BLOCK_ID]);
  const lead = record(block?.[LEAD_ACTION_ID])?.["value"];
  return { meta, lead: typeof lead === "string" ? lead : "" };
}
