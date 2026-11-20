import { describe, expect, it } from "vitest";
import { fakeCtx } from "@render-lab/test-utils";
import { TaskRegistry } from "@renderinc/sdk/workflows";
import { ping } from "../src/main.js";

describe("ping", () => {
  it("returns pong", async () => {
    expect(await ping.func(fakeCtx())).toBe("pong");
  });
});

describe("task registration", () => {
  const names = TaskRegistry.getInstance().getAllTaskNames();

  it("registers the three entry tasks", () => {
    expect(names).toContain("amplifier.checkPosts");
    expect(names).toContain("amplifier.handleEvent");
    expect(names).toContain("amplifier.announcePost");
  });

  it("registers the reminder, which a run starts by name", () => {
    expect(names).toContain("amplifier.remindRepost");
  });

  it("registers the edit tasks, which the receiver starts by name", () => {
    expect(names).toContain("amplifier.editNote");
    expect(names).toContain("amplifier.updateNote");
  });

  it("registers the tasks they compose", () => {
    expect(names).toEqual(
      expect.arrayContaining([
        "typefully.listPublished",
        "llm.complete",
        "amplifier.postNote",
        "amplifier.channelName",
        "kv.lock",
        "kv.unlock",
        "kv.get",
        "kv.set",
        "kv.delete",
      ]),
    );
  });
});
