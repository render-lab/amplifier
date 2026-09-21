import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseEditClick, parseEditSubmit } from "../src/slack/interactivity.js";
import {
  encodeMeta,
  EDIT_CALLBACK_ID,
  LEAD_ACTION_ID,
  LEAD_BLOCK_ID,
} from "../src/slack/editModal.js";
import { EDIT_ACTION_ID, noteActions, section, THREAD_MARKER } from "../src/amplifier/template.js";

const META = {
  channel: "C1",
  messageTs: "17580000.001",
  noteKey: "amplifier:note:1",
  responseUrl: "https://hooks.slack.com/actions/T/1/2",
};

/** An Edit click, the way Slack sends a block action. */
function click(message: Record<string, unknown> = {}) {
  return {
    type: "block_actions",
    actions: [{ action_id: EDIT_ACTION_ID, value: "amplifier:note:1" }],
    trigger_id: "trigger-1",
    channel: { id: "C1" },
    user: { id: "U123" },
    response_url: META.responseUrl,
    message: {
      ts: "17580000.001",
      text: "Old summary",
      blocks: [section(`Old summary${THREAD_MARKER}`), noteActions("social", "amplifier:note:1")],
      ...message,
    },
  };
}

/** A modal submission carrying `lead` in the one input block. */
function submission(lead: string, metadata = encodeMeta(META)) {
  return {
    type: "view_submission",
    user: { id: "U123" },
    view: {
      callback_id: EDIT_CALLBACK_ID,
      private_metadata: metadata,
      state: { values: { [LEAD_BLOCK_ID]: { [LEAD_ACTION_ID]: { value: lead } } } },
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("parseEditClick", () => {
  it("reads the note, the trigger and the current text out of a click", () => {
    expect(parseEditClick(click())).toEqual({
      channel: "C1",
      messageTs: "17580000.001",
      noteKey: "amplifier:note:1",
      triggerId: "trigger-1",
      responseUrl: META.responseUrl,
      lead: "Old summary",
    });
  });

  it("ignores a Repost click, which starts a repost and not an edit", () => {
    const repost = { ...click(), actions: [{ action_id: "amplifier_repost", value: "x" }] };

    expect(parseEditClick(repost)).toBeNull();
  });

  it("falls back to the notification text when the blocks hold no section", () => {
    const noSection = click({ blocks: [noteActions("social", "amplifier:note:1")] });

    expect(parseEditClick(noSection)?.lead).toBe("Old summary");
  });

  it("ignores a click missing anything the modal needs", () => {
    expect(parseEditClick({ ...click(), trigger_id: "" })).toBeNull();
    expect(parseEditClick({ ...click(), actions: [{ action_id: EDIT_ACTION_ID }] })).toBeNull();
    expect(parseEditClick({ ...click(), response_url: "" })).toBeNull();
  });
});

describe("parseEditSubmit", () => {
  it("reads the new lead line and the note it belongs to", () => {
    expect(parseEditSubmit(submission("A new lead line"))).toEqual({
      meta: META,
      lead: "A new lead line",
    });
  });

  it("keeps a blank line, so the receiver can answer with a field error", () => {
    expect(parseEditSubmit(submission("   "))?.lead).toBe("   ");
  });

  it("ignores a submission whose metadata is not amplifier's", () => {
    expect(parseEditSubmit(submission("A new lead line", "{}"))).toBeNull();
  });

  it("ignores a payload that is not a modal submission", () => {
    expect(parseEditSubmit(click())).toBeNull();
  });
});
