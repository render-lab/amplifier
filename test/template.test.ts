import { describe, expect, it } from "vitest";
import type { SlackBlock } from "@render-lab/tasks-slack";
import {
  DEFAULT_CALL_TO_ACTION,
  EDIT_ACTION_ID,
  notePlatforms,
  REPOST_ACTION_ID,
  renderChildren,
  renderFlatNote,
  renderParent,
  withoutNoteActions,
} from "../src/amplifier/template.js";
import type { PostGroup } from "../src/amplifier/group.js";
import { group } from "./support/fixtures.js";

const crossPost = group({
  previews: ["We cut cold starts on Render by 40%."],
  shareUrl: "https://typefully.com/t/abc",
  links: [
    {
      platform: "linkedin",
      url: "https://linkedin.com/feed/update/2",
      publishedAt: "2026-09-04T15:00:00Z",
    },
    { platform: "x", url: "https://x.com/render/status/1", publishedAt: "2026-09-04T15:02:00Z" },
  ],
});

const singleLink: PostGroup = {
  ...crossPost,
  links: [
    { platform: "x", url: "https://x.com/render/status/1", publishedAt: crossPost.publishedAt },
  ],
};

/** The text of every section block, joined the way Slack stacks them. */
function sectionText(blocks: SlackBlock[] | undefined): string {
  return (blocks ?? [])
    .flatMap((b) => {
      const text = (b as { text?: { text?: unknown } }).text?.text;
      return b["type"] === "section" && typeof text === "string" ? [text] : [];
    })
    .join("\n\n");
}

/** The one actions block, or undefined when the parent carries no button. */
function actionsBlock(blocks: SlackBlock[] | undefined): SlackBlock | undefined {
  return (blocks ?? []).find((b) => b["type"] === "actions");
}

describe("renderParent", () => {
  it("uses the summary as the whole body and marks the thread", () => {
    const parent = renderParent(crossPost, { summary: "Cold starts are 40% faster." });
    expect(sectionText(parent.blocks)).toBe("Cold starts are 40% faster. 🧵");
  });

  it("carries no platform link, because the links are replies", () => {
    const body = sectionText(renderParent(crossPost, { summary: "Faster." }).blocks);
    expect(body).not.toContain("https://x.com");
    expect(body).not.toContain("https://linkedin.com");
  });

  it("supplies blocks and no markdown, so the button survives rendering", () => {
    const parent = renderParent(crossPost, { summary: "Faster." });
    expect(parent.markdown).toBeUndefined();
    expect(parent.blocks?.[0]).toMatchObject({ type: "section" });
  });

  it("falls back to the call to action, the failure and the quote", () => {
    const body = sectionText(
      renderParent(crossPost, { summaryError: "401 invalid x-api-key" }).blocks,
    );
    expect(body.startsWith(`${DEFAULT_CALL_TO_ACTION} 🧵`)).toBe(true);
    expect(body).toContain("_(Summarization LLM call failed: 401 invalid x-api-key)_");
    expect(body).toContain("> We cut cold starts on Render by 40%.");
  });

  it("takes a custom call to action", () => {
    const body = sectionText(renderParent(crossPost, { callToAction: "Boost it please." }).blocks);
    expect(body.startsWith("Boost it please. 🧵")).toBe(true);
  });

  it("falls back to the default when the call to action is whitespace-only", () => {
    const body = sectionText(renderParent(crossPost, { callToAction: "   " }).blocks);
    expect(body.startsWith(DEFAULT_CALL_TO_ACTION)).toBe(true);
  });

  it("names one platform the settle deadline dropped", () => {
    const body = sectionText(
      renderParent(crossPost, { summary: "Faster.", droppedPlatforms: ["x"] }).blocks,
    );
    expect(body).toContain("_X had not published yet, so there is no link for it._");
  });

  it("names both dropped platforms in display order", () => {
    const body = sectionText(
      renderParent(crossPost, { summary: "Faster.", droppedPlatforms: ["x", "linkedin"] }).blocks,
    );
    expect(body).toContain(
      "_LinkedIn and X had not published yet, so there are no links for them._",
    );
  });

  it("adds no dropped line when nothing was dropped", () => {
    expect(sectionText(renderParent(crossPost, { summary: "Faster." }).blocks)).not.toContain(
      "had not published yet",
    );
  });

  it("sets the notification fallback to the lead line with no 🧵 and no URL", () => {
    const parent = renderParent(crossPost, { summary: "Cold starts are 40% faster." });
    expect(parent.text).toBe("Cold starts are 40% faster.");
    expect(parent.text).not.toContain("https://");
  });

  it("passes the channel through", () => {
    expect(renderParent(crossPost, { channel: "#social" }).channel).toBe("#social");
  });

  it("omits the channel when none is given", () => {
    expect(renderParent(crossPost).channel).toBeUndefined();
  });

  it("carries the Repost and Edit buttons with a channel and a note key", () => {
    const parent = renderParent(crossPost, {
      summary: "Faster.",
      repostChannel: "amplify-wider",
      noteKey: "amplifier:note:1",
    });
    expect(actionsBlock(parent.blocks)).toEqual({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: REPOST_ACTION_ID,
          text: { type: "plain_text", text: "Repost to #amplify-wider", emoji: true },
          value: "amplifier:note:1",
        },
        {
          type: "button",
          action_id: EDIT_ACTION_ID,
          text: { type: "plain_text", text: "Edit", emoji: true },
          value: "amplifier:note:1",
        },
      ],
    });
  });

  it("gives a flat note both buttons too", () => {
    const flat = renderFlatNote(singleLink, {
      summary: "Faster.",
      repostChannel: "amplify-wider",
      noteKey: "amplifier:note:1",
    });
    const elements = (actionsBlock(flat.blocks) as { elements: { action_id: string }[] }).elements;
    expect(elements.map((e) => e.action_id)).toEqual([REPOST_ACTION_ID, EDIT_ACTION_ID]);
  });

  it("carries no button without a repost channel", () => {
    const parent = renderParent(crossPost, { summary: "Faster.", noteKey: "amplifier:note:1" });
    expect(actionsBlock(parent.blocks)).toBeUndefined();
  });

  it("carries no button without a note key", () => {
    const parent = renderParent(crossPost, { summary: "Faster.", repostChannel: "amplify-wider" });
    expect(actionsBlock(parent.blocks)).toBeUndefined();
  });
});

describe("renderChildren", () => {
  it("returns one reply per platform, LinkedIn first", () => {
    const replies = renderChildren(crossPost);
    expect(replies).toHaveLength(2);
    expect(replies[0]?.markdown).toBe("<https://linkedin.com/feed/update/2|LinkedIn post>");
    expect(replies[1]?.markdown).toBe("<https://x.com/render/status/1|X post>");
  });

  it("labels each reply for the notification fallback, with no URL", () => {
    const replies = renderChildren(crossPost);
    expect(replies.map((r) => r.text)).toEqual(["LinkedIn post", "X post"]);
    expect(replies.every((r) => !r.text.includes("https://"))).toBe(true);
  });

  it("passes the channel through to every reply", () => {
    expect(renderChildren(crossPost, { channel: "#social" }).map((r) => r.channel)).toEqual([
      "#social",
      "#social",
    ]);
  });

  it("keeps one reply per platform when two drafts share a platform", () => {
    const dupe: PostGroup = {
      ...crossPost,
      links: [
        { platform: "x", url: "https://x.com/a", publishedAt: "2026-09-04T15:00:00Z" },
        { platform: "x", url: "https://x.com/b", publishedAt: "2026-09-04T15:01:00Z" },
      ],
    };
    expect(notePlatforms(dupe)).toEqual(["x"]);
    expect(renderChildren(dupe).map((r) => r.markdown)).toEqual(["<https://x.com/a|X post>"]);
  });

  it("falls back to the Typefully draft when a permalink is missing", () => {
    const pending: PostGroup = {
      ...crossPost,
      links: [{ platform: "x", publishedAt: "2026-09-04T15:00:00Z" }],
    };
    expect(renderChildren(pending)[0]?.markdown).toBe(
      "<https://typefully.com/t/abc|X post (Typefully draft)>",
    );
  });

  it("says the link is pending with no permalink and no share URL", () => {
    const pending: PostGroup = {
      draftIds: ["1"],
      previews: ["p"],
      publishedAt: "2026-09-04T15:00:00Z",
      links: [{ platform: "x", publishedAt: "2026-09-04T15:00:00Z" }],
    };
    expect(renderChildren(pending)[0]?.markdown).toBe("X post (link pending)");
  });
});

describe("renderFlatNote", () => {
  it("holds the lead line and the link in one message, with no 🧵", () => {
    const body = sectionText(
      renderFlatNote(singleLink, { summary: "Cold starts are 40% faster." }).blocks,
    );
    expect(body).toBe("Cold starts are 40% faster.\n\n<https://x.com/render/status/1|X post>");
    expect(body).not.toContain("🧵");
  });

  it("does not bullet the one link", () => {
    expect(sectionText(renderFlatNote(singleLink, { summary: "Faster." }).blocks)).not.toContain(
      "•",
    );
  });

  it("keeps the fallback lead line, the failure and the quote", () => {
    const body = sectionText(renderFlatNote(singleLink, { summaryError: "boom" }).blocks);
    expect(body.startsWith(DEFAULT_CALL_TO_ACTION)).toBe(true);
    expect(body).toContain("_(Summarization LLM call failed: boom)_");
    expect(body).toContain("> We cut cold starts on Render by 40%.");
  });

  it("quotes one preview per draft when drafts merged", () => {
    const merged: PostGroup = {
      ...singleLink,
      draftIds: ["1", "2"],
      previews: ["first", "second"],
    };
    const body = sectionText(renderFlatNote(merged).blocks);
    expect(body).toContain("> first");
    expect(body).toContain("> second");
  });

  it("names a dropped platform", () => {
    const body = sectionText(
      renderFlatNote(singleLink, { summary: "Faster.", droppedPlatforms: ["linkedin"] }).blocks,
    );
    expect(body).toContain("_LinkedIn had not published yet, so there is no link for it._");
  });

  it("sets no title and a plain-text fallback with no bare URL", () => {
    const note = renderFlatNote(singleLink, { summary: "Faster." });
    expect(note.title).toBeUndefined();
    expect(note.text).not.toContain("https://");
  });

  it("supplies blocks and no markdown, so the button survives rendering", () => {
    const note = renderFlatNote(singleLink, { summary: "Faster." });
    expect(note.markdown).toBeUndefined();
    expect(note.blocks?.[0]).toMatchObject({ type: "section" });
  });

  it("carries the Repost button, holding the note's key", () => {
    const note = renderFlatNote(singleLink, {
      summary: "Faster.",
      repostChannel: "amplify-wider",
      noteKey: "k",
    });
    expect(actionsBlock(note.blocks)).toMatchObject({
      elements: [
        { text: { text: "Repost to #amplify-wider" }, value: "k" },
        { text: { text: "Edit" }, value: "k" },
      ],
    });
  });

  it("carries no button without a repost channel", () => {
    expect(actionsBlock(renderFlatNote(singleLink, { summary: "Faster." }).blocks)).toBeUndefined();
  });

  it("passes the channel through", () => {
    expect(renderFlatNote(singleLink, { channel: "#social" }).channel).toBe("#social");
  });
});

describe("withoutNoteActions", () => {
  it("drops the actions block and keeps the sections", () => {
    const parent = renderParent(crossPost, {
      summary: "Faster.",
      repostChannel: "amplify-wider",
      noteKey: "k",
    });
    const stripped = withoutNoteActions(parent);
    expect(actionsBlock(stripped.blocks)).toBeUndefined();
    expect(sectionText(stripped.blocks)).toBe("Faster. 🧵");
  });

  it("drops the button from a flat note too", () => {
    const flat = renderFlatNote(singleLink, {
      summary: "Faster.",
      repostChannel: "amplify-wider",
      noteKey: "k",
    });
    const stripped = withoutNoteActions(flat);
    expect(actionsBlock(stripped.blocks)).toBeUndefined();
    expect(sectionText(stripped.blocks)).toContain("Faster.");
  });

  it("leaves a message with no blocks alone", () => {
    const reply = { text: "X post", markdown: "<https://x.com/render/status/1|X post>" };
    expect(withoutNoteActions(reply)).toEqual(reply);
  });
});
