import { describe, expect, it, vi } from "vitest";
import { remindRepostImpl, type RemindRepostInput } from "../src/amplifier/remindRepost.js";
import { CHANNEL_PLACEHOLDER } from "../src/amplifier/remindTemplate.js";
import { remindedKey, repostedKey } from "../src/amplifier/reposted.js";
import { noteKey } from "../src/amplifier/storedNote.js";
import { REPOST_ACTION_ID } from "../src/amplifier/template.js";
import { kvStore } from "./support/kvStore.js";
import { runCtx } from "./support/handlers.js";
import type { TaskCall, TaskHandlers } from "./support/taskCtx.js";

const AT = "2026-09-04T15:00:00Z";
const NOW_MS = Date.parse(AT);

const env = {
  SLACK_BOT_TOKEN: "xoxb",
  SLACK_CHANNEL: "amplify",
  AMPLIFIER_REPOST_CHANNEL: "amplify-wider",
};

const input: RemindRepostInput = {
  channel: "C_NOTE",
  messageTs: "17580000.001",
  dueAtMs: NOW_MS + 30 * 60_000,
  noteKey: noteKey(["1"]),
};

/** A context over a shared fake Key Value, plus the sleeps the run asked for. */
function remindCtx(overrides: TaskHandlers = {}) {
  const kv = kvStore(AT);
  const { ctx, calls } = runCtx({ ...kv.handlers, ...overrides });
  const slept: number[] = [];
  return {
    ctx,
    calls,
    kv,
    slept,
    deps: {
      now: () => NOW_MS,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    },
  };
}

/** Every `amplifier.postNote` input, in the order the run dispatched it. */
function posted(calls: TaskCall[]) {
  return calls.filter((c) => c.name === "amplifier.postNote").map((c) => c.input);
}

describe("keys", () => {
  it("namespaces both markers by the note's drafts, as the note key does", () => {
    expect(repostedKey(noteKey(["1", "2"]))).toBe("amplifier:reposted:1+2");
    expect(remindedKey(noteKey(["1", "2"]))).toBe("amplifier:reminded:1+2");
  });

  it("keeps a key it does not recognize whole, so the marker stays namespaced", () => {
    expect(repostedKey("elsewhere:7")).toBe("amplifier:reposted:elsewhere:7");
  });
});

describe("remindRepostImpl, the delay", () => {
  it("sleeps until dueAtMs", async () => {
    const { ctx, slept, deps } = remindCtx();
    await remindRepostImpl(ctx, input, env, deps);
    expect(slept).toEqual([30 * 60_000]);
  });

  it("sleeps zero when dueAtMs has passed, so a resumed attempt posts at once", async () => {
    const { ctx, calls, slept, deps } = remindCtx();
    await remindRepostImpl(ctx, { ...input, dueAtMs: NOW_MS - 60_000 }, env, deps);
    expect(slept).toEqual([0]);
    expect(posted(calls)).toHaveLength(1);
  });
});

describe("remindRepostImpl, an un-reposted note", () => {
  it("posts one broadcast reply in the note's thread", async () => {
    const { ctx, calls, deps } = remindCtx();
    const result = await remindRepostImpl(ctx, input, env, deps);

    expect(result).toEqual({ reminded: true });
    const sent = posted(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      channel: "C_NOTE",
      threadTs: "17580000.001",
      broadcast: true,
    });
  });

  it("names the repost channel in place of the placeholder", async () => {
    const { ctx, calls, deps } = remindCtx();
    await remindRepostImpl(ctx, input, env, deps);

    const section = posted(calls)[0]?.blocks?.[0];
    expect(section.text.text).toContain("#amplify-wider");
    expect(section.text.text).not.toContain(CHANNEL_PLACEHOLDER);
  });

  it("mentions a channel id and labels the button with its name", async () => {
    const { ctx, calls, deps } = remindCtx({
      "amplifier.channelName": () => ({ name: "amplify-wider" }),
    });
    await remindRepostImpl(ctx, input, { ...env, AMPLIFIER_REPOST_CHANNEL: "C0123ABCD" }, deps);

    const [section, actions] = posted(calls)[0]?.blocks ?? [];
    expect(section.text.text).toContain("shared in <#C0123ABCD>.");
    expect(actions.elements[0].text.text).toBe("Repost to #amplify-wider");
  });

  it("carries its own Repost button, holding the note's key", async () => {
    const { ctx, calls, deps } = remindCtx();
    await remindRepostImpl(ctx, input, env, deps);

    const actions = posted(calls)[0]?.blocks?.find(
      (b: Record<string, unknown>) => b["type"] === "actions",
    );
    expect(actions.elements[0].action_id).toBe(REPOST_ACTION_ID);
    expect(actions.elements[0].value).toBe(noteKey(["1"]));
    expect(actions.elements[0].text.text).toBe("Repost to #amplify-wider");
    expect(actions.elements).toHaveLength(1);
  });

  it("writes the reminded marker before it posts, so a second run posts nothing", async () => {
    const { ctx, calls, kv, deps } = remindCtx();
    await remindRepostImpl(ctx, input, env, deps);

    const names = calls.map((c) => c.name);
    const marked = calls.findIndex(
      (c) => c.name === "kv.set" && c.input.key === remindedKey(input.noteKey),
    );
    expect(marked).toBeGreaterThan(-1);
    expect(marked).toBeLessThan(names.indexOf("amplifier.postNote"));
    expect(kv.keys()).toContain(remindedKey(input.noteKey));
  });
});

describe("remindRepostImpl, a note that needs no reminder", () => {
  it("posts nothing when the reposted marker is set", async () => {
    const { ctx, calls, deps } = remindCtx({
      "kv.get": ({ key }) => ({
        value: key === repostedKey(input.noteKey) ? "reposted" : null,
      }),
    });
    const result = await remindRepostImpl(ctx, input, env, deps);

    expect(result).toEqual({ reminded: false, reason: "reposted" });
    expect(posted(calls)).toHaveLength(0);
  });

  it("posts nothing when the reminded marker is set", async () => {
    const { ctx, calls, deps } = remindCtx({
      "kv.get": ({ key }) => ({
        value: key === remindedKey(input.noteKey) ? "reminded" : null,
      }),
    });
    const result = await remindRepostImpl(ctx, input, env, deps);

    expect(result).toEqual({ reminded: false, reason: "already-reminded" });
    expect(posted(calls)).toHaveLength(0);
  });

  it("posts nothing without a repost channel, and does not even sleep", async () => {
    const { ctx, calls, slept, deps } = remindCtx();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await remindRepostImpl(
        ctx,
        input,
        { SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL: "amplify" },
        deps,
      );
      expect(result).toEqual({ reminded: false, reason: "no-repost-channel" });
      expect(slept).toEqual([]);
      expect(posted(calls)).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });
});

describe("remindRepostImpl, dry run", () => {
  it("logs the reminder and writes nothing, without waiting out the delay", async () => {
    const { ctx, calls, slept, deps } = remindCtx();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await remindRepostImpl(ctx, input, { ...env, DRY_RUN: "true" }, deps);
      expect(result).toEqual({ reminded: false });
      expect(String(log.mock.calls[0]?.[0])).toContain("would remind:");
      expect(slept).toEqual([]);
      expect(posted(calls)).toHaveLength(0);
      expect(calls.some((c) => c.name === "kv.set")).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});
