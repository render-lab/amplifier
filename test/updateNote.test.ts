import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCtx } from "@render-lab/test-utils";
import { updateNoteImpl } from "../src/slack/updateNote.js";
import { section } from "../src/amplifier/template.js";

const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: "xoxb-1" };

/** A fetch that records the form body and answers with `body`. */
function recordingFetch(body: Record<string, unknown>) {
  const calls: { url: string; form: URLSearchParams }[] = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    calls.push({ url, form: new URLSearchParams(init.body) });
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("updateNoteImpl", () => {
  it("sends the new text and blocks to chat.update", async () => {
    const { fetchImpl, calls } = recordingFetch({ ok: true });
    vi.stubGlobal("fetch", fetchImpl);

    const result = await updateNoteImpl(
      fakeCtx({}),
      {
        channel: "C1",
        messageTs: "17580000.001",
        text: "A new lead line",
        blocks: [section("A new lead line")],
      },
      env,
    );

    expect(result).toEqual({ updated: true });
    expect(calls[0]?.url).toContain("/chat.update");
    expect(calls[0]?.form.get("ts")).toBe("17580000.001");
    expect(calls[0]?.form.get("text")).toBe("A new lead line");
    expect(JSON.parse(calls[0]?.form.get("blocks") ?? "[]")).toEqual([section("A new lead line")]);
  });

  it("returns the Slack error rather than throwing, so the editor hears why", async () => {
    const { fetchImpl } = recordingFetch({ ok: false, error: "message_not_found" });
    vi.stubGlobal("fetch", fetchImpl);

    const result = await updateNoteImpl(
      fakeCtx({}),
      { channel: "C1", messageTs: "17580000.001", text: "A new lead line" },
      env,
    );

    expect(result).toEqual({ updated: false, error: "message_not_found" });
  });
});
