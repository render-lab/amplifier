import { describe, expect, it, vi } from "vitest";
import { fakeCtx } from "@render-lab/test-utils";
import { channelDisplayName, channelNameImpl } from "../src/slack/channelName.js";
import { channelMention, isChannelId } from "../src/slack/mrkdwn.js";
import { fakeFetch, withFetch } from "./support/slackFetch.js";
import { taskCtx } from "./support/taskCtx.js";

const ENV = { SLACK_BOT_TOKEN: "xoxb-test" };

describe("isChannelId", () => {
  it("matches public and private channel ids", () => {
    expect(isChannelId("C0123ABCD")).toBe(true);
    expect(isChannelId("G0123ABCD")).toBe(true);
  });

  it("does not match a channel name", () => {
    expect(isChannelId("amplify-wider")).toBe(false);
    expect(isChannelId("general")).toBe(false);
  });
});

describe("channelMention", () => {
  it("writes an id as a mention, which Slack renders as the name", () => {
    expect(channelMention("C0123ABCD")).toBe("<#C0123ABCD>");
  });

  it("writes a name with a #", () => {
    expect(channelMention("amplify-wider")).toBe("#amplify-wider");
  });
});

describe("channelNameImpl", () => {
  it("returns the channel's name", async () => {
    const fetchImpl = fakeFetch({ ok: true, channel: { id: "C0123ABCD", name: "amplify-wider" } });
    const result = await withFetch(fetchImpl, () =>
      channelNameImpl(fakeCtx(), { channel: "C0123ABCD" }, ENV),
    );
    expect(result).toEqual({ name: "amplify-wider" });
    expect(fetchImpl.mock.calls[0]).toEqual([
      "https://slack.com/api/conversations.info",
      expect.objectContaining({ body: "channel=C0123ABCD" }),
    ]);
  });

  it("returns missing_scope rather than throwing", async () => {
    const result = await withFetch(fakeFetch({ ok: false, error: "missing_scope" }), () =>
      channelNameImpl(fakeCtx(), { channel: "C0123ABCD" }, ENV),
    );
    expect(result).toEqual({ error: "missing_scope" });
  });
});

describe("channelDisplayName", () => {
  it("returns a name without calling Slack", async () => {
    const { ctx, calls } = taskCtx({});
    expect(await channelDisplayName(ctx, "amplify-wider")).toBe("amplify-wider");
    expect(calls).toHaveLength(0);
  });

  it("looks up an id", async () => {
    const { ctx } = taskCtx({ "amplifier.channelName": () => ({ name: "amplify-wider" }) });
    expect(await channelDisplayName(ctx, "C0123ABCD")).toBe("amplify-wider");
  });

  it("returns undefined and logs when Slack gives no name", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { ctx } = taskCtx({ "amplifier.channelName": () => ({ error: "missing_scope" }) });
      expect(await channelDisplayName(ctx, "C0123ABCD")).toBeUndefined();
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("returns undefined when the lookup throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { ctx } = taskCtx({
        "amplifier.channelName": () => {
          throw new Error("Slack API conversations.info answered 502");
        },
      });
      expect(await channelDisplayName(ctx, "C0123ABCD")).toBeUndefined();
    } finally {
      error.mockRestore();
    }
  });
});
