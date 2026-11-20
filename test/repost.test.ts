import { beforeEach, describe, expect, it, vi } from "vitest";
import { repostedKey, repostInflightKey } from "../src/amplifier/reposted.js";
import { repostImpl, type RepostInput } from "../src/amplifier/repost.js";
import { loadConfig } from "../src/config.js";
import { INFLIGHT_TTL_SECONDS } from "../src/amplifier/seen.js";
import { noteKey, type StoredNote } from "../src/amplifier/storedNote.js";
import { userTokenKey } from "../src/slack/oauth.js";
import { renderChildren, renderParent } from "../src/amplifier/template.js";
import { group } from "./support/fixtures.js";
import { taskCtx, type TaskCall, type TaskHandlers } from "./support/taskCtx.js";

const NOW = new Date("2026-09-11T12:00:00Z");

const env = {
  SLACK_BOT_TOKEN: "xoxb",
  SLACK_CHANNEL: "#amplify",
  AMPLIFIER_REPOST_CHANNEL: "#amplify-wider",
  SLACK_CLIENT_ID: "1234.5678",
  SLACK_SIGNING_SECRET: "signing-secret",
  AMPLIFIER_PUBLIC_URL: "https://amplifier-webhook.onrender.com",
};

const input: RepostInput = {
  channel: "C1",
  messageTs: "17580000.001",
  userId: "U9",
  noteKey: noteKey(["1"]),
  responseUrl: "https://hooks.slack.com/actions/T/1/2",
};

const crossPost = group({
  links: [
    { platform: "linkedin", url: "https://linkedin.com/b", publishedAt: "2026-09-04T15:00:00Z" },
    { platform: "x", url: "https://x.com/a", publishedAt: "2026-09-04T15:00:00Z" },
  ],
});

const stored: StoredNote = {
  parent: renderParent(crossPost, {
    channel: "#amplify",
    summary: "Cold starts are 40% faster.",
    repostChannel: "amplify-wider",
    noteKey: noteKey(["1"]),
  }),
  replies: renderChildren(crossPost, { channel: "#amplify" }),
};

/** The ephemeral messages the repost sent back through `response_url`. */
function collectReplies(): { texts: string[]; fetchImpl: typeof fetch } {
  const texts: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    texts.push((JSON.parse(init.body) as { text: string }).text);
    return { ok: true, status: 200, text: async () => "ok" };
  }) as unknown as typeof fetch;
  return { texts, fetchImpl };
}

function handlers(overrides: TaskHandlers = {}): TaskHandlers {
  return {
    "kv.get": ({ key }: { key: string }) => {
      if (key === userTokenKey("U9")) return { value: "xoxp-person" };
      // Unreposted, so the claim goes through. A test about a repeat click
      // overrides this.
      if (key === repostedKey(noteKey(["1"]))) return { value: null };
      return { value: JSON.stringify(stored) };
    },
    "kv.set": () => ({ ok: true }),
    "kv.lock": () => ({ acquired: true }),
    "kv.unlock": () => ({ released: true }),
    "amplifier.postNote": () => ({ delivered: true, channel: "C2", ts: "17590000.001" }),
    "slack.addReaction": () => ({ ok: true }),
    ...overrides,
  };
}

function posted(calls: TaskCall[]) {
  return calls.filter((c) => c.name === "amplifier.postNote").map((c) => c.input);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("repostImpl, the happy path", () => {
  it("posts the parent and both replies into the repost channel as the clicker", async () => {
    const { texts, fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(handlers());
    const result = await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    expect(result).toEqual({ reposted: true, threadTs: "17590000.001" });
    const sent = posted(calls);
    // Three into the repost channel, then the Reposted-by reply in the source.
    expect(sent.slice(0, 3).map((m) => m.channel)).toEqual([
      "amplify-wider",
      "amplify-wider",
      "amplify-wider",
    ]);
    expect(sent.slice(0, 3).every((m) => m.userToken === "xoxp-person")).toBe(true);
    expect(texts).toEqual(["Reposted to #amplify-wider."]);
  });

  it("mentions a channel id in the confirmation, so Slack shows its name", async () => {
    const { texts, fetchImpl } = collectReplies();
    const { ctx } = taskCtx(handlers());
    const byId = { ...env, AMPLIFIER_REPOST_CHANNEL: "C0123ABCD" };
    await repostImpl(ctx, input, byId, { fetchImpl, now: () => NOW });

    expect(texts).toEqual(["Reposted to <#C0123ABCD>."]);
  });

  it("keeps the replies in display order, threaded under the new parent", async () => {
    const { fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(handlers());
    await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    const sent = posted(calls);
    expect(sent[1]?.markdown).toContain("|LinkedIn post>");
    expect(sent[2]?.markdown).toContain("|X post>");
    expect(sent[1]?.threadTs).toBe("17590000.001");
    expect(sent[2]?.threadTs).toBe("17590000.001");
  });

  it("strips the button, so a repost cannot be reposted", async () => {
    const { fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(handlers());
    await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    const parent = posted(calls)[0];
    expect(parent?.blocks?.some((b: Record<string, unknown>) => b["type"] === "actions")).toBe(
      false,
    );
    expect(parent?.blocks).toHaveLength(1);
  });

  it("records the note as reposted, so it gets no reminder", async () => {
    const { fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(handlers());
    const config = loadConfig({}, env);
    await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    expect(
      calls.find((c) => c.name === "kv.set" && c.input.key === repostedKey(noteKey(["1"])))?.input,
    ).toEqual({
      key: repostedKey(noteKey(["1"])),
      value: "reposted",
      ttlSeconds: config.seenTtlSeconds,
    });
  });

  it("still reposts when the reposted marker cannot be written", async () => {
    const { texts, fetchImpl } = collectReplies();
    const { ctx } = taskCtx(
      handlers({
        "kv.set": () => {
          throw new Error("kv down");
        },
      }),
    );
    const result = await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });
    expect(result.reposted).toBe(true);
    expect(texts).toEqual(["Reposted to #amplify-wider."]);
  });

  it("reacts to the source parent with the bot token", async () => {
    const { fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(handlers());
    await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    expect(calls.find((c) => c.name === "slack.addReaction")?.input).toEqual({
      channel: "C1",
      ts: "17580000.001",
      emoji: "white_check_mark",
    });
  });

  it("takes the reaction from AMPLIFIER_REPOST_EMOJI", async () => {
    const { fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(handlers());
    await repostImpl(
      ctx,
      input,
      { ...env, AMPLIFIER_REPOST_EMOJI: "loudspeaker" },
      {
        fetchImpl,
        now: () => NOW,
      },
    );

    expect(calls.find((c) => c.name === "slack.addReaction")?.input.emoji).toBe("loudspeaker");
  });

  it("replies in the source thread naming who reposted, with the bot token", async () => {
    const { fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(handlers());
    await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    const reply = posted(calls).at(-1);
    expect(reply).toMatchObject({
      channel: "C1",
      markdown: "Reposted by <@U9>",
      threadTs: "17580000.001",
    });
    expect(reply).not.toHaveProperty("userToken");
  });

  it("treats already_reacted as success, so the reaction does not fail the repost", async () => {
    const { texts, fetchImpl } = collectReplies();
    const { ctx } = taskCtx(
      handlers({
        "slack.addReaction": () => {
          throw new Error("Slack API reactions.add error: already_reacted");
        },
      }),
    );
    const result = await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });
    expect(result.reposted).toBe(true);
    expect(texts).toEqual(["Reposted to #amplify-wider."]);
  });
});

describe("repostImpl, the refusals", () => {
  it("sends the authorize link when the clicker has no token", async () => {
    const { texts, fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(handlers({ "kv.get": () => ({ value: null }) }));
    const result = await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    expect(result).toEqual({ reposted: false, reason: "no-token" });
    expect(posted(calls)).toHaveLength(0);
    expect(texts[0]).toContain("https://slack.com/oauth/v2/authorize?");
    expect(texts[0]).toContain("user_scope=chat%3Awrite");
    expect(texts[0]).toContain(
      "redirect_uri=https%3A%2F%2Famplifier-webhook.onrender.com%2Fslack%2Foauth%2Fcallback",
    );
  });

  it("says so when the authorize link cannot be built", async () => {
    const { texts, fetchImpl } = collectReplies();
    const { ctx } = taskCtx(handlers({ "kv.get": () => ({ value: null }) }));
    const { SLACK_CLIENT_ID: _dropped, ...noClientId } = env;
    const result = await repostImpl(ctx, input, noClientId, { fetchImpl, now: () => NOW });

    expect(result).toEqual({ reposted: false, reason: "no-authorize-link" });
    expect(texts[0]).toContain("SLACK_CLIENT_ID");
  });

  it("says so when the stored note has expired", async () => {
    const { texts, fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(
      handlers({
        "kv.get": ({ key }: { key: string }) =>
          key === userTokenKey("U9") ? { value: "xoxp-person" } : { value: null },
      }),
    );
    const result = await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    expect(result).toEqual({ reposted: false, reason: "no-note" });
    expect(posted(calls)).toHaveLength(0);
    expect(texts[0]).toContain("no stored text for this note");
  });

  it("asks the clicker to join the channel on not_in_channel", async () => {
    const { texts, fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(
      handlers({
        "amplifier.postNote": () => {
          throw new Error("Slack API chat.postMessage error: not_in_channel");
        },
      }),
    );
    const result = await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    expect(result).toEqual({ reposted: false, reason: "not-in-channel" });
    expect(texts[0]).toContain("Join #amplify-wider");
    expect(calls.some((c) => c.name === "slack.addReaction")).toBe(false);
  });

  it("reads the code through the subtask wrapper the workflow runtime adds", async () => {
    const { texts, fetchImpl } = collectReplies();
    const { ctx } = taskCtx(
      handlers({
        "amplifier.postNote": () => {
          throw new Error("Subtask failed: Slack API chat.postMessage error: not_in_channel");
        },
      }),
    );
    const result = await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    expect(result).toEqual({ reposted: false, reason: "not-in-channel" });
    expect(texts[0]).toContain("Join #amplify-wider");
  });

  it("rethrows a failure whose text merely mentions a code it handles", async () => {
    const { fetchImpl } = collectReplies();
    const { ctx } = taskCtx(
      handlers({
        "amplifier.postNote": () => {
          throw new Error(
            'Slack API chat.postMessage error: invalid_blocks, on block {"text":"not_in_channel"}',
          );
        },
      }),
    );
    await expect(repostImpl(ctx, input, env, { fetchImpl, now: () => NOW })).rejects.toThrow(
      /invalid_blocks/,
    );
  });

  it("rethrows any other Slack failure, so REPOST_RETRY fires", async () => {
    const { fetchImpl } = collectReplies();
    const { ctx } = taskCtx(
      handlers({
        "amplifier.postNote": () => {
          throw new Error("Slack API chat.postMessage error: ratelimited");
        },
      }),
    );
    await expect(repostImpl(ctx, input, env, { fetchImpl, now: () => NOW })).rejects.toThrow(
      /ratelimited/,
    );
  });

  it("says so when no repost channel is configured", async () => {
    const { texts, fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(handlers());
    const { AMPLIFIER_REPOST_CHANNEL: _dropped, ...noChannel } = env;
    const result = await repostImpl(ctx, input, noChannel, { fetchImpl, now: () => NOW });

    expect(result).toEqual({ reposted: false, reason: "no-repost-channel" });
    expect(calls).toHaveLength(0);
    expect(texts[0]).toContain("AMPLIFIER_REPOST_CHANNEL");
  });

  it("posts nothing and skips the reaction under DRY_RUN", async () => {
    const { texts, fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(handlers());
    const result = await repostImpl(
      ctx,
      input,
      { ...env, DRY_RUN: "true" },
      {
        fetchImpl,
        now: () => NOW,
      },
    );

    expect(result).toEqual({ reposted: false });
    expect(posted(calls)).toHaveLength(0);
    expect(calls.some((c) => c.name === "slack.addReaction")).toBe(false);
    expect(texts).toEqual([]);
  });
});

describe("repostImpl and a repeat click", () => {
  it("claims the note before it posts the parent", async () => {
    const { fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(handlers());
    await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    const names = calls.map((c) => c.name);
    expect(names.indexOf("kv.lock")).toBeLessThan(names.indexOf("amplifier.postNote"));
    expect(calls.find((c) => c.name === "kv.lock")?.input).toEqual({
      key: repostInflightKey(noteKey(["1"])),
      token: expect.stringMatching(/^amplifier:run:/),
      ttlSeconds: INFLIGHT_TTL_SECONDS,
    });
  });

  it("keeps the lock once the thread is posted, so a retry cannot post it twice", async () => {
    const { fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(handlers());
    const result = await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    expect(result.reposted).toBe(true);
    expect(calls.some((c) => c.name === "kv.unlock")).toBe(false);
  });

  it("posts nothing when the note is already reposted, and says so", async () => {
    const { texts, fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(
      handlers({
        "kv.get": ({ key }: { key: string }) => {
          if (key === userTokenKey("U9")) return { value: "xoxp-person" };
          if (key === repostedKey(noteKey(["1"]))) return { value: "reposted" };
          return { value: JSON.stringify(stored) };
        },
      }),
    );
    const result = await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    expect(result).toEqual({ reposted: false, reason: "already-reposted" });
    expect(posted(calls)).toEqual([]);
    expect(texts).toEqual(["Somebody already reposted this note to #amplify-wider."]);
  });

  it("posts nothing while another click is reposting, and says so", async () => {
    const { texts, fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(handlers({ "kv.lock": () => ({ acquired: false }) }));
    const result = await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    expect(result).toEqual({ reposted: false, reason: "repost-in-flight" });
    expect(posted(calls)).toEqual([]);
    expect(texts).toEqual([
      "This note is being reposted to #amplify-wider right now. Check the channel in a few " +
        "minutes, and click again if nothing landed.",
    ]);
  });

  it("releases the lock when Slack refuses the clicker the channel", async () => {
    const { texts, fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(
      handlers({
        "amplifier.postNote": () => {
          throw new Error("Slack API chat.postMessage error: not_in_channel");
        },
      }),
    );
    const result = await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    expect(result.reason).toBe("not-in-channel");
    // Released, so the same person can join the channel and click again.
    expect(calls.find((c) => c.name === "kv.unlock")?.input).toEqual({
      key: repostInflightKey(noteKey(["1"])),
      token: expect.stringMatching(/^amplifier:run:/),
    });
    expect(texts[0]).toContain("Join #amplify-wider");
  });

  it("refuses a reposted note before it asks the clicker to authorize", async () => {
    const { texts, fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(
      handlers({
        // Nobody's token, so the old order would have sent the authorize link.
        "kv.get": ({ key }: { key: string }) => {
          if (key === userTokenKey("U9")) return { value: null };
          if (key === repostedKey(noteKey(["1"]))) return { value: "reposted" };
          return { value: JSON.stringify(stored) };
        },
      }),
    );
    const result = await repostImpl(ctx, input, env, { fetchImpl, now: () => NOW });

    expect(result).toEqual({ reposted: false, reason: "already-reposted" });
    expect(texts).toEqual(["Somebody already reposted this note to #amplify-wider."]);
    expect(calls.some((c) => c.name === "kv.lock")).toBe(false);
  });

  it("keeps the claim when the parent post fails for any other reason", async () => {
    const { fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(
      handlers({
        "amplifier.postNote": () => {
          throw new Error("Slack API chat.postMessage error: ratelimited");
        },
      }),
    );

    await expect(repostImpl(ctx, input, env, { fetchImpl, now: () => NOW })).rejects.toThrow(
      "ratelimited",
    );
    // Slack may have taken the post it failed to report, so the retry is given
    // up rather than risking a second thread.
    expect(calls.some((c) => c.name === "kv.unlock")).toBe(false);
  });

  it("takes no lock in a dry run", async () => {
    const { fetchImpl } = collectReplies();
    const { ctx, calls } = taskCtx(handlers());
    await repostImpl(ctx, input, { ...env, DRY_RUN: "true" }, { fetchImpl, now: () => NOW });

    expect(calls.some((c) => c.name === "kv.lock")).toBe(false);
  });
});
