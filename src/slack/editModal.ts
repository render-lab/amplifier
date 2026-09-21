import type { SlackJsonValue } from "@render-lab/tasks-slack";
import { nonEmptyString, record } from "../json.js";

/** The `callback_id` the modal carries, which the receiver matches on submit. */
export const EDIT_CALLBACK_ID = "amplifier_edit_note";

/** The input block, and the element inside it, the submission is read from. */
export const LEAD_BLOCK_ID = "amplifier_edit_lead";
export const LEAD_ACTION_ID = "amplifier_edit_lead_input";

/** Longest lead the modal accepts. The 3000-character section block holds the links too. */
export const MAX_LEAD_LENGTH = 2000;

/** A Block Kit view, which has no type in `@render-lab/tasks-slack` 0.3.0. */
export type SlackView = { [key: string]: SlackJsonValue };

/** Which note an open modal is editing, and how to answer the editor. */
export interface EditMeta {
  /** Channel the note is in, as the id the click carried. */
  channel: string;
  /** The note's own `ts`, which `chat.update` rewrites. */
  messageTs: string;
  /** Key Value key of the stored note, from the Edit button's `value`. */
  noteKey: string;
  /**
   * The Edit click's `response_url`, kept because a `view_submission` has none.
   *
   * Slack keeps one alive for 30 minutes, so a modal left open longer loses its
   * confirmation and nothing else.
   */
  responseUrl: string;
}

/** The modal's `private_metadata`. Slack hands it back on submit, so nothing is kept in memory. */
export function encodeMeta(meta: EditMeta): string {
  return JSON.stringify(meta);
}

/** The note a submitted modal was editing, or null when the field is not ours. */
export function decodeMeta(value: unknown): EditMeta | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const m = record(parsed);
  if (!m) return null;
  const channel = nonEmptyString(m["channel"]);
  const messageTs = nonEmptyString(m["messageTs"]);
  const noteKey = nonEmptyString(m["noteKey"]);
  const responseUrl = nonEmptyString(m["responseUrl"]);
  if (!channel || !messageTs || !noteKey || !responseUrl) return null;
  return { channel, messageTs, noteKey, responseUrl };
}

/**
 * The edit modal, prefilled with the note's current lead line.
 *
 * One input, because the links are thread replies. The hint says so.
 */
export function editView(meta: EditMeta, lead: string): SlackView {
  return {
    type: "modal",
    callback_id: EDIT_CALLBACK_ID,
    private_metadata: encodeMeta(meta),
    title: { type: "plain_text", text: "Edit note" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: LEAD_BLOCK_ID,
        label: { type: "plain_text", text: "Note text" },
        hint: {
          type: "plain_text",
          text: "The links stay as they are. The repost button posts this text.",
        },
        element: {
          type: "plain_text_input",
          action_id: LEAD_ACTION_ID,
          multiline: true,
          initial_value: lead,
          max_length: MAX_LEAD_LENGTH,
        },
      },
    ],
  };
}
