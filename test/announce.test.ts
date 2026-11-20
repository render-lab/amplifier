import { describe, expect, it, vi } from "vitest";
import { announceGroups } from "../src/amplifier/announce.js";
import { loadConfig } from "../src/config.js";
import { noteKey, type StoredNote } from "../src/amplifier/storedNote.js";
import { groupPosts } from "../src/amplifier/group.js";
import { messageBody, post } from "./support/fixtures.js";
import { taskCtx, type TaskCall, type TaskHandlers } from "./support/taskCtx.js";

const AT = "2026-09-04T15:00:00Z";

/** The announce path with every task stubbed: a summary, locks, and a delivered post. */
function handlers(overrides: TaskHandlers = {}): TaskHandlers {
  let ts = 0;
  return {
    "llm.complete": () => ({ text: "Cold starts are 40% faster.", stopReason: "end_turn" }),
    "kv.get": () => ({ value: null }),
    "kv.set": () => ({ ok: true }),
    "kv.lock": () => ({ acquired: true }),
    "kv.unlock": () => ({ released: true }),
    "amplifier.postNote": () => ({
      delivered: true,
      channel: "C1",
      ts: `17580000.00${(ts += 1)}`,
    }),
    "amplifier.pingOwners": ({ draftId }) => ({ draftId, dryRun: false, pinged: [] }),
    ...overrides,
  };
}

/** Every `amplifier.postNote` input, in the order announce dispatched it. */
function posted(calls: TaskCall[]) {
  return calls.filter((c) => c.name === "amplifier.postNote").map((c) => c.input);
}

const env = { SLACK_BOT_TOKEN: "xoxb", SLACK_CHANNEL: "#amplify" };
const crossPost = groupPosts([post("1", AT, ["linkedin", "x"])], 0);
const singlePost = groupPosts([post("2", AT, ["x"])], 0);

describe("announceGroups, cross-posted", () => {
  it("posts a parent and one reply per platform, in display order", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, crossPost, loadConfig({}, env), "run-1");

    const sent = posted(calls);
    expect(sent).toHaveLength(3);
    expect(sent[0]?.blocks).toBeDefined();
    expect(sent[1]?.markdown).toContain("|LinkedIn post>");
    expect(sent[2]?.markdown).toContain("|X post>");
  });

  it("replies in the parent's thread", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, crossPost, loadConfig({}, env), "run-1");

    const sent = posted(calls);
    const parentTs = "17580000.001";
    expect(sent[0]).not.toHaveProperty("threadTs");
    expect(sent[1]?.threadTs).toBe(parentTs);
    expect(sent[2]?.threadTs).toBe(parentTs);
  });

  it("reports the parent's ts as the note's threadTs", async () => {
    const { ctx } = taskCtx(handlers());
    const { notes } = await announceGroups(ctx, crossPost, loadConfig({}, env), "run-1");
    expect(notes[0]).toMatchObject({ delivered: true, threadTs: "17580000.001" });
  });

  it("marks the drafts announced as soon as the parent is delivered", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, crossPost, loadConfig({}, env), "run-1");

    const names = calls.map((c) => c.name);
    const marked = calls.findIndex(
      (c) => c.name === "kv.set" && c.input.key === "amplifier:seen:1",
    );
    const firstReply = names.indexOf("amplifier.postNote", names.indexOf("amplifier.postNote") + 1);
    expect(marked).toBeGreaterThan(-1);
    expect(marked).toBeLessThan(firstReply);
  });

  it("keeps the drafts announced when a reply fails", async () => {
    let n = 0;
    const { ctx, calls } = taskCtx(
      handlers({
        "amplifier.postNote": () => {
          n += 1;
          if (n === 1) return { delivered: true, channel: "C1", ts: "17580000.001" };
          throw new Error("Slack API chat.postMessage error: ratelimited");
        },
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { notes } = await announceGroups(ctx, crossPost, loadConfig({}, env), "run-1");
      expect(notes[0]?.delivered).toBe(true);
      expect(calls.some((c) => c.name === "kv.set" && c.input.key === "amplifier:seen:1")).toBe(
        true,
      );
    } finally {
      error.mockRestore();
    }
  });
});

describe("announceGroups, the stored note", () => {
  const withRepost = { ...env, AMPLIFIER_REPOST_CHANNEL: "#amplify-wider" };

  it("stores the parent and the replies under the group's key", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, crossPost, loadConfig({}, withRepost), "run-1");

    const stored = calls.find((c) => c.name === "kv.set" && c.input.key === noteKey(["1"]));
    expect(stored).toBeDefined();
    const note = JSON.parse(stored?.input.value as string) as StoredNote;
    expect(note.replies.map((r) => r.markdown)).toEqual([
      "<https://example.com/linkedin/1|LinkedIn post>",
      "<https://example.com/x/1|X post>",
    ]);
    expect(note.parent.blocks?.some((b) => b["type"] === "actions")).toBe(true);
  });

  it("carries the seen TTL, so the record and the marker expire together", async () => {
    const { ctx, calls } = taskCtx(handlers());
    const config = loadConfig({}, withRepost);
    await announceGroups(ctx, crossPost, config, "run-1");

    const stored = calls.find((c) => c.name === "kv.set" && c.input.key === noteKey(["1"]));
    expect(stored?.input.ttlSeconds).toBe(config.seenTtlSeconds);
  });

  it("puts the button on the parent, holding the note's key", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, crossPost, loadConfig({}, withRepost), "run-1");

    const actions = posted(calls)[0]?.blocks?.find(
      (b: Record<string, unknown>) => b["type"] === "actions",
    );
    expect(actions.elements[0].value).toBe(noteKey(["1"]));
    expect(actions.elements[0].text.text).toBe("Repost to #amplify-wider");
  });

  it("looks up the name once per run when the repost channel is an id", async () => {
    const { ctx, calls } = taskCtx(
      handlers({ "amplifier.channelName": () => ({ name: "amplify-wider" }) }),
    );
    const byId = { ...env, AMPLIFIER_REPOST_CHANNEL: "C0123ABCD" };
    await announceGroups(ctx, [...crossPost, ...singlePost], loadConfig({}, byId), "run-1");

    expect(calls.filter((c) => c.name === "amplifier.channelName")).toHaveLength(1);
    const labels = posted(calls)
      .flatMap((p) => p.blocks ?? [])
      .filter((b: Record<string, unknown>) => b["type"] === "actions")
      .map((b: { elements: { text: { text: string } }[] }) => b.elements[0]?.text.text);
    expect(labels).toEqual(["Repost to #amplify-wider", "Repost to #amplify-wider"]);
  });

  it("stores nothing and adds no button without a repost channel", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, crossPost, loadConfig({}, env), "run-1");

    expect(calls.some((c) => c.name === "kv.set" && c.input.key === noteKey(["1"]))).toBe(false);
    expect(
      posted(calls)[0]?.blocks?.some((b: Record<string, unknown>) => b["type"] === "actions"),
    ).toBe(false);
  });
});

describe("announceGroups, one link", () => {
  it("posts one flat message and no reply", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, singlePost, loadConfig({}, env), "run-1");

    const sent = posted(calls);
    expect(sent).toHaveLength(1);
    expect(messageBody(sent[0])).toContain("|X post>");
    expect(messageBody(sent[0])).not.toContain("🧵");
  });

  it("carries the button and stores the note, so an owner has something to click", async () => {
    const withRepost = { ...env, AMPLIFIER_REPOST_CHANNEL: "#amplify-wider" };
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, singlePost, loadConfig({}, withRepost), "run-1");

    const actions = posted(calls)[0]?.blocks?.find(
      (b: Record<string, unknown>) => b["type"] === "actions",
    );
    expect(actions.elements[0].value).toBe(noteKey(["2"]));
    const stored = calls.find((c) => c.name === "kv.set" && c.input.key === noteKey(["2"]));
    const note = JSON.parse(stored?.input.value as string) as StoredNote;
    expect(note.replies).toEqual([]);
  });
});

describe("announceGroups, the owner DMs", () => {
  const withNotion = { ...env, NOTION_DATABASE_ID: "db_1", NOTION_TOKEN: "ntn_test" };

  it("pings the launch's owners after the replies, with the parent's channel and ts", async () => {
    const { ctx, calls } = taskCtx(handlers());
    await announceGroups(ctx, crossPost, loadConfig({}, withNotion), "run-1");

    const names = calls.map((c) => c.name);
    expect(names.lastIndexOf("amplifier.postNote")).toBeLessThan(
      names.indexOf("amplifier.pingOwners"),
    );
    expect(calls.find((c) => c.name === "amplifier.pingOwners")?.input).toEqual({
      draftId: "1",
      noteChannel: "C1",
      noteTs: "17580000.001",
    });
  });

  it("leaves the announcement delivered when the ping fails", async () => {
    const { ctx, calls } = taskCtx(
      handlers({
        "amplifier.pingOwners": () => {
          throw new Error("notion down");
        },
      }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { notes } = await announceGroups(ctx, crossPost, loadConfig({}, withNotion), "run-1");

      expect(notes[0]?.delivered).toBe(true);
      expect(calls.some((c) => c.name === "kv.set" && c.input.key === "amplifier:seen:1")).toBe(
        true,
      );
      expect(error.mock.calls[0]?.[0]).toMatch(/The owner DMs for 1 failed/);
    } finally {
      error.mockRestore();
    }
  });

  it("pings nobody when AMPLIFIER_PING_OWNERS is false", async () => {
    const { ctx, calls } = taskCtx(handlers());
    const off = { ...withNotion, AMPLIFIER_PING_OWNERS: "false" };
    await announceGroups(ctx, crossPost, loadConfig({}, off), "run-1");

    expect(calls.some((c) => c.name === "amplifier.pingOwners")).toBe(false);
  });

  it("pings nobody when the note was not delivered", async () => {
    const { ctx, calls } = taskCtx(
      handlers({ "amplifier.postNote": () => ({ delivered: false }) }),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await announceGroups(ctx, crossPost, loadConfig({}, withNotion), "run-1");
      expect(calls.some((c) => c.name === "amplifier.pingOwners")).toBe(false);
    } finally {
      error.mockRestore();
    }
  });
});

describe("announceGroups, the repost reminder", () => {
  const withRepost = { ...env, AMPLIFIER_REPOST_CHANNEL: "#amplify-wider" };

  /** A fake dispatch, recording the task and args announce asked for. */
  function fakeStartRun() {
    const started: { task: string; args: unknown[] }[] = [];
    return {
      started,
      startRun: async (task: string, args: unknown[]) => {
        started.push({ task, args });
      },
    };
  }

  it("starts one run with the note's channel, ts, key and due time", async () => {
    const { ctx } = taskCtx(handlers());
    const { started, startRun } = fakeStartRun();
    const before = Date.now();
    await announceGroups(ctx, crossPost, loadConfig({}, withRepost), "run-1", { startRun });

    expect(started).toHaveLength(1);
    expect(started[0]?.task).toBe("amplifier.remindRepost");
    const [arg] = started[0]?.args as [
      { channel: string; messageTs: string; dueAtMs: number; noteKey: string },
    ];
    expect(arg.channel).toBe("C1");
    expect(arg.messageTs).toBe("17580000.001");
    expect(arg.noteKey).toBe(noteKey(["1"]));
    expect(arg.dueAtMs).toBeGreaterThanOrEqual(before + 30 * 60_000);
  });

  it("leaves the announcement delivered when the dispatch throws", async () => {
    const { ctx } = taskCtx(handlers());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { notes } = await announceGroups(ctx, crossPost, loadConfig({}, withRepost), "run-1", {
        startRun: () => Promise.reject(new Error("render api down")),
      });
      expect(notes[0]?.delivered).toBe(true);
      expect(error.mock.calls[0]?.[0]).toMatch(/repost reminder run did not start/);
    } finally {
      error.mockRestore();
    }
  });

  it("starts nothing with AMPLIFIER_REMINDER_MINUTES at 0", async () => {
    const { ctx } = taskCtx(handlers());
    const { started, startRun } = fakeStartRun();
    const off = { ...withRepost, AMPLIFIER_REMINDER_MINUTES: "0" };
    await announceGroups(ctx, crossPost, loadConfig({}, off), "run-1", { startRun });
    expect(started).toEqual([]);
  });

  it("starts nothing without a repost channel, because there is nothing to ask for", async () => {
    const { ctx } = taskCtx(handlers());
    const { started, startRun } = fakeStartRun();
    await announceGroups(ctx, crossPost, loadConfig({}, env), "run-1", { startRun });
    expect(started).toEqual([]);
  });
});

describe("announceGroups, dry run", () => {
  it("logs the parent and every reply in order and posts nothing", async () => {
    const { ctx, calls } = taskCtx(handlers());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await announceGroups(ctx, crossPost, loadConfig({ dryRun: true }, env), "run-1");
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines[0]).toContain("would post:");
      expect(lines[0]).toContain("🧵");
      expect(lines[1]).toContain("|LinkedIn post>");
      expect(lines[2]).toContain("|X post>");
      expect(posted(calls)).toHaveLength(0);
    } finally {
      log.mockRestore();
    }
  });

  it("pings nobody, because there is no thread to link to", async () => {
    const { ctx, calls } = taskCtx(handlers());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const withNotion = { ...env, NOTION_DATABASE_ID: "db_1", NOTION_TOKEN: "ntn_test" };
      await announceGroups(ctx, crossPost, loadConfig({ dryRun: true }, withNotion), "run-1");
      expect(calls.some((c) => c.name === "amplifier.pingOwners")).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it("writes nothing to Key Value", async () => {
    const { ctx, calls } = taskCtx(handlers());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const withRepost = { ...env, AMPLIFIER_REPOST_CHANNEL: "#amplify-wider" };
      await announceGroups(ctx, crossPost, loadConfig({ dryRun: true }, withRepost), "run-1");
      expect(calls.some((c) => c.name === "kv.set")).toBe(false);
    } finally {
      log.mockRestore();
    }
  });

  it("starts no reminder run, because there is no posted note to remind about", async () => {
    const { ctx } = taskCtx(handlers());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const started: string[] = [];
    try {
      const withRepost = { ...env, AMPLIFIER_REPOST_CHANNEL: "#amplify-wider" };
      await announceGroups(ctx, crossPost, loadConfig({ dryRun: true }, withRepost), "run-1", {
        startRun: async (task: string) => {
          started.push(task);
        },
      });
      expect(started).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
});
