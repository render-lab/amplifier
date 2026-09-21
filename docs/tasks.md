# Render Tasks in Amplifier

[Render Tasks](https://github.com/render-lab/render-tasks) is a set of packages that wrap vendor APIs
as [Render Workflows](https://render.com/docs/workflows) tasks. In amplifier, every network call out
of the process runs as one of those tasks: Typefully, Anthropic, Render Key Value, and Slack. Each
task carries its own retry policy, and a run that dies part way through resumes from the last
completed task.

The packages are a proof of concept and break their APIs between releases, so `package.json` pins
every version exactly. `@renderinc/sdk` is pinned to `1.0.0` because each package declares it as an
exact peer dependency: one physical copy means every task registers into the same `TaskRegistry`.

## What amplifier takes from each package

| Package                       | Version        | What amplifier uses it for                                                                                                                                        |
| ----------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@render-lab/tasks-render-kv` | 0.3.0          | `get`, `set`, `deleteKeys`, `lock`, `unlock`. `src/amplifier/seen.ts` builds the announced markers and the in-flight locks from them.                             |
| `@render-lab/tasks-slack`     | 0.3.0          | `postMessageImpl`, `webApiPort`, `addReaction`, and `SLACK_RETRY`. `src/slack/postNote.ts` wraps the first three.                                                 |
| `@render-lab/tasks-llm`       | 0.8.1          | `complete`, called in `src/summary/summarize.ts` for the note's lead line.                                                                                        |
| `@render-lab/tasks-core`      | 0.3.0          | `createHttpClient`, which backs the Typefully port in `src/typefully/client.ts` and the Notion port in `src/notion/client.ts`. Defines no tasks.                  |
| `@render-lab/triggers`        | 0.2.0          | `createDispatchServer`, `renderDispatcher`, and the `WebhookAdapter` contract, which are the whole `amplifier-webhook` service.                                   |
| `hono` + `@hono/node-server`  | 4.13.5 / 2.1.1 | The Slack routes mount on the Hono app `createDispatchServer` returns, and the receiver serves it itself. Pinned to the versions `@render-lab/triggers` resolves. |
| `@render-lab/test-utils`      | 0.1.0          | `fakeCtx` for the tests and `localCtx` for `pnpm local:run`.                                                                                                      |

## Amplifier's own tasks

Eight tasks are entry points, started from outside the workflow. The rest are composed from them.

| Task                      | Started by                                   | Retry                |
| ------------------------- | -------------------------------------------- | -------------------- |
| `amplifier.checkPosts`    | By hand, to rescan the lookback window       | none                 |
| `amplifier.handleEvent`   | A Typefully `draft.published` delivery       | `HANDLE_EVENT_RETRY` |
| `amplifier.announcePost`  | By hand, with a permalink or draft id        | none                 |
| `amplifier.pingOwners`    | `announceGroups`, and by hand with a page id | none                 |
| `amplifier.repost`        | A Repost button click in Slack               | `REPOST_RETRY`       |
| `amplifier.editNote`      | A saved edit modal in Slack                  | `EDIT_RETRY`         |
| `amplifier.remindRepost`  | `announceGroups`, as its own run             | `REMIND_RETRY`       |
| `amplifier.saveUserToken` | The Slack OAuth callback                     | none                 |
| `amplifier.postNote`      | Every task above that posts to Slack         | `SLACK_RETRY`        |
| `amplifier.updateNote`    | `editNote`, to rewrite the posted note       | `SLACK_RETRY`        |
| `amplifier.lookupUser`    | `pingOwners`, per owner                      | `SLACK_RETRY`        |
| `amplifier.openDm`        | `pingOwners`, per owner                      | `SLACK_RETRY`        |
| `amplifier.messageLink`   | `pingOwners`, for the thread the DM links to | `SLACK_RETRY`        |
| `typefully.listPublished` | `checkPosts`, `announcePost`, `pingOwners`   | `TYPEFULLY_RETRY`    |
| `notion.findLaunches`     | `pingOwners`, to find the launch page        | `NOTION_RETRY`       |
| `notion.getPage`          | `pingOwners`, to read the owners             | `NOTION_RETRY`       |
| `ping`                    | By hand, to check the registry loaded        | none                 |

`src/main.ts` imports the eight entry modules for the side effect. Each one calls `task()` at load, so
the import registers that task and, through its own imports, every vendor task it calls. A new entry
task that is not imported there does not exist on the deploy. To confirm the registry loaded, run
`render workflows start <slug>/ping --input='[]'` and expect `pong`.

`amplifier.checkPosts` is the one to read first. It composes the whole announce path as `ctx.run`
calls: `typefully.listPublished`, then `kv.get` per draft, then `llm.complete`, `kv.lock`,
`amplifier.postNote`, `kv.set`, `kv.unlock` inside `announceGroups`.

`amplifier.handleEvent` registers `checkPostsImpl` directly rather than calling `ctx.run(checkPosts)`.
No second dispatch, no second poll interval. It exists to carry its own retry policy and its own name
in the Dashboard.

Amplifier's tasks compose vendor tasks instead of calling vendor clients, except where no packaged
task covers the call. `saveUserTokenImpl` posts to `oauth.v2.access` through an injected `fetchImpl`.
`amplifier.lookupUser`, `amplifier.openDm`, `amplifier.messageLink` and `amplifier.updateNote` go
through `callSlack` in `src/slack/api.ts`, because `SlackWebPort` in 0.3.0 wraps none of
`users.lookupByEmail`, `conversations.open` or `chat.update`, and its own `slack.getPermalink`
throws on an `ok: false` body and ignores `SLACK_API_BASE_URL`. `callSlack` returns the `ok: false` body instead: `users_not_found` is an
answer about one person, not a transport failure.

## Where the retry policies matter

`HANDLE_EVENT_RETRY` is not only resilience. A Typefully delivery arrives when the first platform
publishes, so `checkPostsImpl` throws `StillPublishingError` and the retry backoff — 1m, 2m, 4m, 8m —
is how amplifier waits for the second platform. Two things depend on that budget:

- `MAX_SETTLE_MINUTES` in `src/amplifier/retry.ts` computes the total backoff and `loadConfig` caps
  `AMPLIFIER_SETTLE_MINUTES` at it. A settle deadline past the retry budget means the retries run out
  before the deadline and the post gets no note.
- `announceGroups` calls `summarizeGroup` before taking the in-flight lock, because the `complete`
  task spends about 62 seconds of backoff and `INFLIGHT_TTL_SECONDS` is 300. Inside the lock, the lock
  could expire mid-call and a second run would re-post the note.

`REPOST_RETRY` is short — 1s, 2s, 4s, 8s — because a person clicked the button and is waiting for the
ephemeral answer. A long backoff reads as a dead button. `EDIT_RETRY` is the same shape for the same
reason, and a retry re-runs both of `amplifier.editNote`'s writes, which repeat harmlessly. It can only fire before the parent message is
posted; everything after that either swallows its own failure or answers the clicker and returns.

`REMIND_RETRY` is for crash recovery. The reminder's delay is a `setTimeout` inside
`amplifier.remindRepost`, because `RunSubtaskRequest` in `@renderinc/sdk` 1.0.0 has no delay field and
a started run begins at once. A deploy during the sleep kills the task, and the resumed attempt waits
out what is left of `dueAtMs` rather than the whole delay again. `MAX_REMINDER_MINUTES` in
`src/amplifier/retry.ts` caps `AMPLIFIER_REMINDER_MINUTES` against `REMIND_TIMEOUT_SECONDS`, because a
delay past the task's timeout kills the run before it reads either marker.

The reminder carries its own Repost button, holding the same note key as the parent's, so
`parseRepostClick` reads the clicked message's `thread_ts` and falls back to its `ts`. A click on
the reminder is about the note at the top of the thread, which is where the reaction, the
"Reposted by" reply and the reposted marker belong.

`announceGroups` starts `amplifier.remindRepost` as its own run rather than as a subtask, so
cancelling or redeploying the announce path does not take the reminder with it. `startRun` in
`src/amplifier/dispatchRun.ts` makes that call, which means the Workflow service needs `RENDER_API_KEY`
and `WORKFLOW_SLUG` of its own. Without them `startRun` logs and returns null, which is what keeps
`pnpm local:run` off the Render API.

`amplifier.announcePost` and `amplifier.saveUserToken` have no retry policy on purpose. A human is
watching the first one, and an OAuth code is single-use, so a retry after a successful exchange fails
with `invalid_code` and turns a working authorization into a reported failure.

Typefully rate limits are absorbed in-process instead of by a retry policy. `typefullyPort` passes
`retry` to `createHttpClient`, because a durable re-dispatch re-fires the same request and sustains the
limit.

## Dispatching in parallel

Each `ctx.run` polls its own subtask every 500ms, so sequential calls pay that interval each time.
`announcedDraftIds` and `markAnnounced` in `src/amplifier/seen.ts` dispatch their Key Value calls with
`Promise.all` for that reason — 25 sequential reads would wait through 25 poll intervals.

Two places stay sequential deliberately. `claimGroup` takes the locks one at a time so it can release
what it already holds and give up on the first refusal. `postReplies` posts the thread's replies in
order, because the order the links appear is part of the note's format.

`claimNote` in `src/amplifier/repostClaim.ts` locks the note before it reads the reposted marker, for
the same reason `claimGroup` re-reads the announced marker after each lock: the other click writes its
marker in the window a marker-first read opens. `amplifier.repost` also reads that marker once without
the lock, before it reads the clicker's token, so a click on an already-reposted note is not answered
with an authorize link.

## Where amplifier reaches past a packaged task

`amplifier.postNote` wraps `postMessageImpl` under its own name because the packaged behavior is wrong
for amplifier in three ways:

- Slack unfurls every link it finds, including links inside a section block. `chat.postMessage` accepts
  `unfurl_links` and `unfurl_media`, but `@render-lab/tasks-slack` 0.3.0 sends neither and exposes no
  option, so `outgoingFetch` adds them to the request body on the way out.
- `thread_ts` rides the same rewrite. `PostMessageInput` has no field for it in 0.3.0, and amplifier's
  notes are threads.
- It throws when Slack is unconfigured, instead of letting the packaged webhook port log the note and
  return `delivered: false`. A run that cannot post must not report success.

`SLACK_API_BASE_URL` is the same kind of hole. `webApiPort` builds `https://slack.com/api` into the URL
itself, so `outgoingFetch` rewrites the host when that variable is set. `pnpm local:run` uses it to
point the announce path at the local stub, the way `TYPEFULLY_BASE_URL` already does for Typefully.

The wrapper builds its `SlackDeps` per call, so `SLACK_BOT_TOKEN` is read at call time and not at
import. That also gives `amplifier.repost` posting-as-a-person for free: it hands `webApiPort` a copy
of the environment with `SLACK_BOT_TOKEN` replaced by the clicker's user token, which keeps the second
identity inside the vendor's client instead of adding a second HTTP path.

`src/amplifier/storedNote.ts` exists for a missing task. `amplifier.repost` needs the thread's content,
and 0.3.0 wraps no `conversations.replies` task, so reading the thread back from Slack would mean a raw
API call and a `channels:history` scope. `announceGroups` writes the rendered messages to Key Value
when it posts them instead.

## The Typefully and Notion ports

`listPublishedImpl` takes a `TypefullyDeps` object with a default, and the default port is built on
first use through a getter, never at import. `TYPEFULLY_API_KEY` and `TYPEFULLY_BASE_URL` come from the
environment the run has rather than the one the module loaded in. Tests pass a fake port.
`typefullyWebhook` reads `TYPEFULLY_WEBHOOK_SECRET` the same way, so an unconfigured receiver rejects
deliveries instead of answering 500 to every one of them.

`notion.getPage` and `notion.findLaunches` take a `NotionDeps` object built the same way, and
`src/notion/client.ts` pins the `Notion-Version` header in code rather than in the environment,
because Notion changes response shapes between versions. Both ports pass their variable name and
real base URL to `checkedBaseUrl` in `src/http/baseUrl.ts`, so `TYPEFULLY_BASE_URL`,
`NOTION_BASE_URL` and `SLACK_API_BASE_URL` can only name the real API or a loopback address. A
credential cannot be redirected to a third party by setting one variable.

## The receiver

Workflows have no HTTP entry point, so `amplifier-webhook` is a separate Render web service. It verifies
an inbound request and starts a run through the Render API with `RENDER_API_KEY` and `WORKFLOW_SLUG`.

`src/receiver.ts` calls `createDispatchServer` rather than `serveDispatchServer`, because the two Slack
routes mount on the Hono app it returns. They cannot be `WebhookAdapter`s: Slack sends interactivity as
form-encoded with the JSON in a `payload` field, and the adapter path `JSON.parse`s the body before
`map` ever sees it. The three routes that start runs are:

- `POST /webhooks/typefully` — the adapter in `src/typefully/webhook.ts`. `verify` checks the
  HMAC-SHA256 signature and the timestamp, and `map` returns `{ task: "amplifier.handleEvent", args }`
  or `null` to ignore the event. `verify` is the only thing between a public URL and a workflow run,
  because `POST /webhooks/:name` does not check `DISPATCH_TOKEN`.
- `POST /slack/interactivity` — answers 200 before dispatching `amplifier.repost`, because Slack's
  interactivity budget is three seconds and starting a run is slower than that.
- `GET /slack/oauth/callback` — waits on `amplifier.saveUserToken` with `dispatcher.run` and a
  20-second timeout, so the browser gets a real answer instead of a page that says "probably".

`GET /healthz` is the Render health check path. `DISPATCH_TOKEN` stays unset, which makes
`POST /tasks/:task` answer 401 to everything. Nothing in amplifier uses that route.

## Testing

`fakeCtx()` returns a context whose `run` throws. `test/listPublished.test.ts` uses it bare for a leaf
task, so a call that unexpectedly chains a subtask fails loudly instead of receiving `undefined`. For a
task that does chain, `test/support/taskCtx.ts` wraps `fakeCtx` with a `run` that dispatches by task
name to stub handlers and records every call in order. An unstubbed name still throws.

`test/support/handlers.ts` builds on that with `runCtx`, a context where every task an entry point
chains already succeeds, so a test overrides only the one it is about. `test/support/kvStore.ts` is a
Map-backed Key Value with a virtual clock, which is how a test ages a marker or an in-flight lock.
`test/support/notionPort.ts` fakes the Notion port, and `test/support/fixtures.ts` builds the
`PublishedPost` and `PostGroup` values the announce tests share.

`localCtx()` runs chained tasks in-process by invoking each target's undecorated function.
`scripts/local-run.ts` uses it to drive the whole announce path against a local Key Value with no
credentials. It checks the wiring and the Key Value state, not durability: no retries and no timeouts.

## Upgrading a package

Change the exact version, then check the places amplifier reaches past the packaged task:

1. `src/slack/postNote.ts` requires a channel and a bot token, mirroring the condition `postMessageImpl`
   uses to take the Web API route. A change to that condition makes the two disagree about when Slack is
   configured, and only that route returns the `ts` a thread reply needs.
2. The same file patches the request body as JSON. A body the vendor no longer serializes as JSON
   throws in `rewriteBody`.
3. `@render-lab/test-utils` calls each task's undecorated `func`, so a change to how `task()` stores it
   breaks `localCtx` and `test/main.test.ts`.
4. `@renderinc/sdk` must stay one physical copy at the version every package pins. Two copies mean two
   registries and an empty task list on deploy.

Run `pnpm check` and `render workflows start <slug>/ping --input='[]'` after any upgrade.
