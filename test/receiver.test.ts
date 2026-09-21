import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkflowDispatcher } from "@render-lab/triggers";
import { buildReceiver } from "../src/receiver.js";
import { CALLBACK_PATH, signState } from "../src/slack/oauth.js";
import {
  EDIT_ACTION_ID,
  noteActions,
  REPOST_ACTION_ID,
  section,
} from "../src/amplifier/template.js";
import {
  encodeMeta,
  EDIT_CALLBACK_ID,
  LEAD_ACTION_ID,
  LEAD_BLOCK_ID,
} from "../src/slack/editModal.js";
import { slackSignedHeaders } from "./support/slackSignature.js";

const SECRET = "signing-secret";
const USER = "U123";
const NOW_MS = Date.parse("2026-09-11T12:00:00Z");
const TIMESTAMP = String(Math.floor(NOW_MS / 1000));
const BASE = "https://amplifier-webhook.onrender.com";

/**
 * Past the 64 KiB cap `POST /slack/interactivity` enforces, and under the 1 MiB
 * cap the rest of the service uses, so it pins the tighter cap to that route.
 */
const OVER_INTERACTIVITY_CAP_BYTES = 128 * 1024;

/** The content type Slack posts interactivity with. */
const FORM_ENCODED = { "content-type": "application/x-www-form-urlencoded" };

const env: NodeJS.ProcessEnv = {
  SLACK_SIGNING_SECRET: SECRET,
  AMPLIFIER_PUBLIC_URL: BASE,
  SLACK_BOT_TOKEN: "xoxb-1",
};

/**
 * A dispatcher whose `run` answers with `results`, in the shape the Render API
 * uses: an array holding one entry per argument the task was started with.
 */
function dispatcherReturning(results: unknown, timedOut = false): WorkflowDispatcher {
  return {
    start: async () => ({ runId: "run-1" }),
    run: async () => ({ runId: "run-1", status: "succeeded", results, timedOut }),
  };
}

/** A dispatcher that records every `start` call instead of dispatching. */
function recordingDispatcher() {
  const started: { task: string; args: unknown[] }[] = [];
  const dispatcher = {
    start: async (task: string, args: unknown[]) => {
      started.push({ task, args });
      return { runId: "run-1" };
    },
    run: async () => ({ runId: "run-1", status: "succeeded", results: [], timedOut: false }),
  } as unknown as WorkflowDispatcher;
  return { dispatcher, started };
}

/** A form-encoded interactivity body, the way Slack posts a button click. */
function clickBody(payload: unknown): string {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

function receiver(dispatcher: WorkflowDispatcher) {
  return buildReceiver({
    dispatcher,
    workflowSlug: "amplifier",
    env,
    now: () => new Date(NOW_MS),
  });
}

function callback(dispatcher: WorkflowDispatcher, state: string) {
  return receiver(dispatcher).request(
    `${CALLBACK_PATH}?code=abc&state=${encodeURIComponent(state)}`,
  );
}

function interactivity(
  dispatcher: WorkflowDispatcher,
  body: string,
  headers: Record<string, string>,
) {
  return receiver(dispatcher).request("/slack/interactivity", { method: "POST", body, headers });
}

describe("GET /slack/oauth/callback", () => {
  const state = signState(USER, SECRET, NOW_MS);

  it("reports success when the run saved the token", async () => {
    const res = await callback(dispatcherReturning([{ saved: true }]), state);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Authorized");
  });

  it("reports the error the run returned", async () => {
    const results = [{ saved: false, error: "Slack rejected the exchange: invalid_code." }];

    const res = await callback(dispatcherReturning(results), state);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid_code");
  });

  it("rejects a state it did not sign", async () => {
    const res = await callback(dispatcherReturning([{ saved: true }]), `${USER}:0:deadbeef`);

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("not issued by amplifier");
  });

  it("asks the clicker to try again when the exchange outlasts the wait", async () => {
    const res = await callback(dispatcherReturning(undefined, true), state);

    expect(res.status).toBe(504);
  });
});

describe("POST /slack/interactivity", () => {
  const click = {
    actions: [{ action_id: REPOST_ACTION_ID, value: "amplifier:note:1" }],
    channel: { id: "C1" },
    message: { ts: "17580000.001" },
    user: { id: USER },
    response_url: "https://hooks.slack.com/actions/T/1/2",
  };

  it("starts a repost for a signed click", async () => {
    const { dispatcher, started } = recordingDispatcher();
    const body = clickBody(click);

    const res = await interactivity(dispatcher, body, {
      ...FORM_ENCODED,
      ...slackSignedHeaders(body, SECRET, TIMESTAMP),
    });

    expect(res.status).toBe(200);
    expect(started).toEqual([
      {
        task: "amplifier.repost",
        args: [
          {
            channel: "C1",
            messageTs: "17580000.001",
            userId: USER,
            noteKey: "amplifier:note:1",
            responseUrl: "https://hooks.slack.com/actions/T/1/2",
          },
        ],
      },
    ]);
  });

  it("rejects a body over the cap before it checks the signature", async () => {
    const { dispatcher, started } = recordingDispatcher();
    const body = clickBody({ ...click, padding: "A".repeat(OVER_INTERACTIVITY_CAP_BYTES) });

    const res = await interactivity(dispatcher, body, FORM_ENCODED);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload too large" });
    expect(started).toEqual([]);
  });

  it("rejects a body under the cap with a forged signature", async () => {
    const { dispatcher, started } = recordingDispatcher();
    const body = clickBody(click);

    const res = await interactivity(dispatcher, body, {
      ...FORM_ENCODED,
      ...slackSignedHeaders(body, "wrong-secret", TIMESTAMP),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid signature" });
    expect(started).toEqual([]);
  });
});

describe("POST /slack/interactivity, editing", () => {
  const editClick = {
    type: "block_actions",
    actions: [{ action_id: EDIT_ACTION_ID, value: "amplifier:note:1" }],
    trigger_id: "trigger-1",
    channel: { id: "C1" },
    user: { id: USER },
    response_url: "https://hooks.slack.com/actions/T/1/2",
    message: {
      ts: "17580000.001",
      text: "Old summary",
      blocks: [section("Old summary 🧵"), noteActions("social", "amplifier:note:1")],
    },
  };
  const submission = {
    type: "view_submission",
    user: { id: USER },
    view: {
      callback_id: EDIT_CALLBACK_ID,
      private_metadata: encodeMeta({
        channel: "C1",
        messageTs: "17580000.001",
        noteKey: "amplifier:note:1",
        responseUrl: "https://hooks.slack.com/actions/T/1/2",
      }),
      state: {
        values: { [LEAD_BLOCK_ID]: { [LEAD_ACTION_ID]: { value: "  A new lead line  " } } },
      },
    },
  };

  /** Records every Slack Web API call the receiver makes. */
  function slackCalls(body: Record<string, unknown> = { ok: true }) {
    const calls: { url: string; form: URLSearchParams }[] = [];
    const fetchImpl = (async (url: string, init: { body: string }) => {
      calls.push({ url, form: new URLSearchParams(init.body) });
      return { ok: true, status: 200, json: async () => body, text: async () => "" };
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the modal prefilled with the note's current text", async () => {
    const { dispatcher, started } = recordingDispatcher();
    const { calls, fetchImpl } = slackCalls();
    vi.stubGlobal("fetch", fetchImpl);
    const body = clickBody(editClick);

    const res = await interactivity(dispatcher, body, {
      ...FORM_ENCODED,
      ...slackSignedHeaders(body, SECRET, TIMESTAMP),
    });

    expect(res.status).toBe(200);
    expect(calls[0]?.url).toContain("/views.open");
    expect(calls[0]?.form.get("trigger_id")).toBe("trigger-1");
    const view = JSON.parse(calls[0]?.form.get("view") ?? "{}");
    expect(view.blocks[0].element.initial_value).toBe("Old summary");
    expect(started).toEqual([]);
  });

  it("starts no repost for an Edit click", async () => {
    const { dispatcher, started } = recordingDispatcher();
    const { fetchImpl } = slackCalls();
    vi.stubGlobal("fetch", fetchImpl);
    const body = clickBody(editClick);

    await interactivity(dispatcher, body, {
      ...FORM_ENCODED,
      ...slackSignedHeaders(body, SECRET, TIMESTAMP),
    });

    expect(started).toEqual([]);
  });

  it("starts the edit with the trimmed text and closes the modal", async () => {
    const { dispatcher, started } = recordingDispatcher();
    const body = clickBody(submission);

    const res = await interactivity(dispatcher, body, {
      ...FORM_ENCODED,
      ...slackSignedHeaders(body, SECRET, TIMESTAMP),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(started).toEqual([
      {
        task: "amplifier.editNote",
        args: [
          {
            channel: "C1",
            messageTs: "17580000.001",
            noteKey: "amplifier:note:1",
            responseUrl: "https://hooks.slack.com/actions/T/1/2",
            lead: "A new lead line",
          },
        ],
      },
    ]);
  });

  it("answers a blank edit with a field error and starts nothing", async () => {
    const { dispatcher, started } = recordingDispatcher();
    const blank = {
      ...submission,
      view: {
        ...submission.view,
        state: { values: { [LEAD_BLOCK_ID]: { [LEAD_ACTION_ID]: { value: "   " } } } },
      },
    };
    const body = clickBody(blank);

    const res = await interactivity(dispatcher, body, {
      ...FORM_ENCODED,
      ...slackSignedHeaders(body, SECRET, TIMESTAMP),
    });

    expect(await res.json()).toEqual({
      response_action: "errors",
      errors: { [LEAD_BLOCK_ID]: "Write the note's text." },
    });
    expect(started).toEqual([]);
  });

  it("tells the clicker when Slack will not open the modal", async () => {
    const { dispatcher } = recordingDispatcher();
    const { calls, fetchImpl } = slackCalls({ ok: false, error: "expired_trigger_id" });
    vi.stubGlobal("fetch", fetchImpl);
    const body = clickBody(editClick);

    await interactivity(dispatcher, body, {
      ...FORM_ENCODED,
      ...slackSignedHeaders(body, SECRET, TIMESTAMP),
    });

    const answered = calls.find((c) => c.url.startsWith("https://hooks.slack.com"));
    expect(answered).toBeDefined();
  });
});
