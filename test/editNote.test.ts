import { beforeEach, describe, expect, it, vi } from "vitest";
import { editNoteImpl } from "../src/amplifier/editNote.js";
import { repostedKey } from "../src/amplifier/reposted.js";
import { noteActions, section, THREAD_MARKER } from "../src/amplifier/template.js";
import { noteKey } from "../src/amplifier/storedNote.js";
import { taskCtx, type TaskHandlers } from "./support/taskCtx.js";

const NOTE = noteKey(["1", "2"]);
const INPUT = {
  channel: "C1",
  messageTs: "17580000.001",
  noteKey: NOTE,
  lead: "A new lead line",
  responseUrl: "https://hooks.slack.com/actions/T/1/2",
};

const env: NodeJS.ProcessEnv = {
  SLACK_BOT_TOKEN: "xoxb-1",
  SLACK_CHANNEL: "amplify-queue",
  AMPLIFIER_REPOST_CHANNEL: "social",
};

const stored = {
  parent: {
    text: "Old summary",
    blocks: [section(`Old summary${THREAD_MARKER}`), noteActions("social", NOTE)],
  },
  replies: [{ text: "X", markdown: "<https://x.com/1|X>" }],
};

function handlers(overrides: TaskHandlers = {}): TaskHandlers {
  return {
    "kv.get": (input) => (input.key === NOTE ? { value: JSON.stringify(stored) } : { value: null }),
    "kv.set": () => ({ ok: true }),
    "amplifier.updateNote": () => ({ updated: true }),
    ...overrides,
  };
}

/** Records what the editor was told, instead of posting to a response_url. */
function recordingFetch() {
  const said: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    said.push((JSON.parse(init.body) as { text: string }).text);
    return { ok: true, status: 200, text: async () => "" };
  }) as unknown as typeof fetch;
  return { said, fetchImpl };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("editNoteImpl", () => {
  it("rewrites the note in the channel with the new lead line", async () => {
    const { ctx, calls } = taskCtx(handlers());
    const { fetchImpl } = recordingFetch();

    const result = await editNoteImpl(ctx, INPUT, env, { fetchImpl });

    expect(result).toEqual({ edited: true });
    const update = calls.find((c) => c.name === "amplifier.updateNote");
    expect(update?.input.text).toBe("A new lead line");
    expect(update?.input.blocks[0]).toEqual(section(`A new lead line${THREAD_MARKER}`));
    expect(update?.input.blocks[1]).toEqual(noteActions("social", NOTE));
  });

  it("writes the edited parent back, so the Repost button posts the new text", async () => {
    const { ctx, calls } = taskCtx(handlers());
    const { fetchImpl } = recordingFetch();

    await editNoteImpl(ctx, INPUT, env, { fetchImpl });

    const set = calls.find((c) => c.name === "kv.set");
    const written = JSON.parse(set?.input.value);
    expect(written.parent.text).toBe("A new lead line");
    expect(written.replies).toEqual(stored.replies);
  });

  it("updates Slack before Key Value, so a failed update changes nothing", async () => {
    const { ctx, calls } = taskCtx(handlers());
    const { fetchImpl } = recordingFetch();

    await editNoteImpl(ctx, INPUT, env, { fetchImpl });

    const names = calls.map((c) => c.name);
    expect(names.indexOf("amplifier.updateNote")).toBeLessThan(names.indexOf("kv.set"));
  });

  it("tells the editor the button now posts the new text", async () => {
    const { ctx } = taskCtx(handlers());
    const { said, fetchImpl } = recordingFetch();

    await editNoteImpl(ctx, INPUT, env, { fetchImpl });

    expect(said[0]).toContain("Repost");
  });

  it("says the reposted copy is unchanged when this note was already reposted", async () => {
    const { ctx } = taskCtx(
      handlers({
        "kv.get": (input) =>
          input.key === NOTE
            ? { value: JSON.stringify(stored) }
            : input.key === repostedKey(NOTE)
              ? { value: "reposted" }
              : { value: null },
      }),
    );
    const { said, fetchImpl } = recordingFetch();

    await editNoteImpl(ctx, INPUT, env, { fetchImpl });

    expect(said[0]).toContain("already reposted");
  });

  it("refuses a note whose stored text has expired", async () => {
    const { ctx, calls } = taskCtx(handlers({ "kv.get": () => ({ value: null }) }));
    const { said, fetchImpl } = recordingFetch();

    const result = await editNoteImpl(ctx, INPUT, env, { fetchImpl });

    expect(result).toEqual({ edited: false, reason: "no-note" });
    expect(calls.map((c) => c.name)).not.toContain("amplifier.updateNote");
    expect(said[0]).toContain("no stored text");
  });

  it("leaves the stored note alone when Slack refuses the update", async () => {
    const { ctx, calls } = taskCtx(
      handlers({ "amplifier.updateNote": () => ({ updated: false, error: "message_not_found" }) }),
    );
    const { said, fetchImpl } = recordingFetch();

    const result = await editNoteImpl(ctx, INPUT, env, { fetchImpl });

    expect(result).toEqual({ edited: false, reason: "slack-error" });
    expect(calls.map((c) => c.name)).not.toContain("kv.set");
    expect(said[0]).toContain("message_not_found");
  });

  it("writes nothing in a dry run", async () => {
    const { ctx, calls } = taskCtx(handlers());
    const { fetchImpl } = recordingFetch();

    const result = await editNoteImpl(ctx, INPUT, { ...env, DRY_RUN: "true" }, { fetchImpl });

    expect(result).toEqual({ edited: false });
    expect(calls.map((c) => c.name)).toEqual(["kv.get"]);
  });
});
