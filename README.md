# Amplifier

Amplifier automates the process of sharing new LinkedIn and Twitter posts with the Render team. Whenever a post goes live on Twitter and/or LinkedIn, Amplifier sends a Slack note to the `#amplify` channel.

It reads published drafts from Typefully, which is where the Render Twitter and LinkedIn accounts are scheduled. A post sent to both platforms produces one Slack thread, with a link per platform as a reply. Anyone in the channel can click Repost on that thread to post it again in a second channel, as themselves.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/render-lab/amplifier)

The button applies `render.yaml`, which covers the webhook receiver, the Key Value instance,
and the env groups. It does not create the Workflow service, because Blueprints do not support
Workflows yet. Read [Deployment](docs/deployment.md) first; the button is step 5.

## How it works

```
   post goes live
        │
        ▼
┌────────────────────┐   POST        ┌──────────────────────────┐
│ Typefully          │ ────────────▶ │ amplifier-webhook        │
│ Settings > API     │  /webhooks/   │ web service              │
└────────────────────┘   typefully   └────────────┬─────────────┘
                                      verify, map │ dispatch
                                                  ▼
                                     ┌──────────────────────────┐
                                     │ amplifier (Workflow)     │
                                     │ amplifier.handleEvent    │
                                     └────────────┬─────────────┘
  1  typefully.listPublished ─────────────────────┼──▶ Typefully API
  2  withinWindow, then announcedDraftIds ────────┼──▶ amplifier-kv
  3  settle check for pending platforms           │
  4  groupPosts                                   │
  5  llm.complete ────────────────────────────────┼──▶ Anthropic
  6  claimGroup, one kv.lock per draft ───────────┼──▶ amplifier-kv
  7  amplifier.postNote, parent then replies ─────┼──▶ Slack #amplify
  8  markAnnounced, then releaseGroup ────────────┼──▶ amplifier-kv
  9  amplifier.pingOwners ────────────────────────┤──▶ Notion API, Slack DMs
 10  start amplifier.remindRepost, its own run ───┴──▶ Render API
```

Steps 5 through 10 run once per group.

Typefully posts to the `amplifier-webhook` service when a draft publishes. The receiver verifies the delivery and starts `amplifier.handleEvent` on the amplifier Workflow service, which retries at 1m, 2m, 4m, and 8m while a platform is still publishing. That task:

1. Calls `typefully.listPublished` for published drafts in the configured social set.
2. Keeps the drafts published in the last 90 minutes, then drops the ones Render Key Value already records as announced.
3. Throws while the event's draft is enabled for a platform that has not reported a permalink, so a retry re-reads Typefully a minute later. Past the 10-minute settle deadline it announces the draft with whatever links exist, and the note names the platform it has no link for.
4. Groups the rest, when they were published close together on different platforms, into one note.
5. Asks Claude Sonnet 5, through `llm.complete`, for the one line that opens the note.
6. Takes a 5-minute lock per draft.
7. Posts the note through `amplifier.postNote`: a parent message, then one threaded reply per platform link.
8. Records each draft as announced for 30 days.
9. Runs `amplifier.pingOwners`, which finds the launch page in Notion and DMs each owner the link to the note it just posted. See [Pinging a launch's owners](#pinging-a-launchs-owners).
10. Starts `amplifier.remindRepost` as its own run, which sleeps 30 minutes and then reminds the channel if nobody reposted the note. See [Repost reminders](#repost-reminders).

`amplifier.postNote` wraps the vendor's `postMessageImpl` and adds `unfurl_links: false`, `unfurl_media: false` and, on a reply, `thread_ts` to the request body. `@render-lab/tasks-slack` 0.3.0 sends none of them and exposes no option for them. The wrapper can go away once the vendor does.

Every note carries a Repost button and an Edit button. A cross-post is a thread: the parent carries the summary line and the 🧵, and each platform link is a reply.

```
Cursor Origin is now a supported Git provider on Render. Help spread the word 🧵
[ Repost to #amplify-wider ] [ Edit ]
  └ <https://linkedin.com/…|LinkedIn post>
  └ <https://x.com/…|X post>
```

A post that only went out on one platform is one flat message, with no thread and no 🧵:

```
Please like/share our new customer story for OpenAI

<https://x.com/…|X post>
[ Repost to #amplify-wider ] [ Edit ]
```

When the summary call fails, the note still goes out. The parent opens with `AMPLIFIER_CALL_TO_ACTION`, names the reason, and quotes the draft preview.

The announced marker is written as soon as the parent is delivered, not after the last reply. A failed reply leaves the thread missing a link, which is logged. The alternative is a later run posting a second parent.

Dedupe is per draft, not per note, so a LinkedIn post that arrives after its Twitter twin was announced still gets its own note.

Delivery is at least once. The announced marker is written after Slack accepts the parent, so a run that dies in the gap between the two loses its lock within 5 minutes and the next run posts the same note again. The design accepts a duplicate note so that no note is lost.

## Local development

```bash
pnpm install
pnpm test          # unit tests, no secrets needed
cp .env.example .env
render workflows dev -- pnpm dev
# in another terminal:
render workflows tasks list --local
render workflows start amplifier.checkPosts --local --input='[{}]'
```

`.env.example` sets `DRY_RUN=true`, so a local run logs the note it would post and writes nothing to Slack.

Run this before committing:

```bash
pnpm check
```

### End-to-end run with no credentials

`scripts/typefully-stub.ts` stands in for both Typefully and the Slack Web API, so the whole announce-once path runs against a local Key Value with no keys:

```bash
redis-server &
pnpm stub &
pnpm local:run 2
```

The argument is how many runs to do in a row. Run 1 reports `notified: 2`. Run 2 reports `notified: 0` and `skipped: 2`, which is the announce-once guarantee holding across runs. `redis-cli --scan --pattern 'amplifier:*'` should then show two `amplifier:seen:` markers and no `amplifier:inflight:` locks.

Edit the drafts in the stub to cover other cases. Reversing them puts the oldest first, which is the failure the deployment checks below are looking for: `limit` truncates the response to the oldest drafts, every run reports `inWindow: 0`, and nothing posts without erroring.

This runs every task in one process with no retries and no timeouts, so it checks the wiring and the Key Value state, not durability. It also cannot tell you the real Typefully response shape, which is what the first deployment check is for.

The stub listens on port 8787. Set `STUB_PORT` to use a different one.

### Webhook receiver on localhost

`pnpm webhook:post` signs the captured Typefully event in `test/support/typefully-event.json` and posts it to a receiver running on this machine, which checks the signature and the mapping without a deploy:

```bash
pnpm build
PORT=3000 WORKFLOW_SLUG=<slug> RENDER_API_KEY=<key> \
  TYPEFULLY_WEBHOOK_SECRET=whsec_local pnpm trigger:serve &
TYPEFULLY_WEBHOOK_SECRET=whsec_local pnpm webhook:post 101
```

The argument is the draft id to put in the payload, so the event can point at whatever the stub serves. A 202 means the signature and the mapping worked, and the receiver has started a run on the Workflow service that `WORKFLOW_SLUG` names without waiting for it. A 401 means the secret here and the secret the receiver read do not match.

## Deployment

[docs/deployment.md](docs/deployment.md) has the numbered steps: the Slack app, the Workflow
service, the two env groups, the Blueprint apply, the Typefully webhook and the Notion
integration. It also covers the Slack credentials and the OAuth redirect.

## Reposting

When `AMPLIFIER_REPOST_CHANNEL` is set, every note carries a **Repost to #<channel>**
button: on the parent of a cross-post thread, and on a single-platform note. Anyone in the
source channel can click it. The note is posted again in the repost channel, as the clicker
rather than as the bot, and the source message gets an `AMPLIFIER_REPOST_EMOJI` reaction and
a "Reposted by" reply.

The first click asks for a one-time authorization. Amplifier has no token for that person
yet, so it answers privately with an authorize link. Approving it grants `chat:write` for
that one person, and clicking Repost again does the repost. The token is stored in
`amplifier-kv` with no expiry, so nobody has to authorize twice.

Every person who clicks has to be a member of the repost channel. Slack answers
`not_in_channel` when they are not, and amplifier answers privately asking them to join
it. The bot never posts in the repost channel and does not need to be a member.

The button stays live after a click, but a second click does not repost the note. Amplifier
takes a 5-minute lock on the note and then reads the reposted marker, so a click while the
first repost is going out answers privately that it is already going out, and a click after
it landed answers that somebody already reposted it. A reposted note carries no button, so a
repost cannot itself be reposted.

The lock is held, not released, once the parent is posted, so a retry of `amplifier.repost`
cannot post the thread twice. A repost that fails on the parent post is not retried either,
because `chat.postMessage` is not idempotent and Slack may have accepted a message it then
failed to report. The failure is logged, the clicker is told to check the repost channel, and
the button works again once the lock expires five minutes later.

`amplifier.repost` reads the note's text from `amplifier-kv`, not from Slack. The record
carries the same 30-day TTL as the announced marker, so an older note answers that it is
too old to repost.

Unset `AMPLIFIER_REPOST_CHANNEL` to turn all of this off: no button, no stored note.

## Editing a note

A note that carries a Repost button carries an **Edit** button beside it. Clicking Edit opens a
box holding the note's current text.

Saving rewrites the note in the channel and the stored copy the Repost button posts. Slack marks
the note as edited.

The links come from Typefully and cannot be edited here.

Editing a note that was already reposted changes the note in the source channel only. The
reposted copy stays as it went out, and the confirmation says so.

Notes posted before this shipped carry no Edit button.

The receiver needs `SLACK_BOT_TOKEN` in `amplifier-triggers`, because it opens the box itself. A
Slack `trigger_id` expires in three seconds, which is too little to start a workflow run first.
It is the same `xoxb-` token `amplifier-workflow` holds, so paste the same value into both
groups. Add it to the group rather than to the `amplifier-webhook` service, because
`render.yaml` gives the service only `fromGroup: amplifier-triggers` and a variable set on the
service is removed on the next Blueprint sync. Redeploy the receiver afterwards.

Without the token, a click on Edit does nothing and Slack shows "This app responded with Status
Code 500". Repost still works, because that path only starts a run. The receiver's log says
`SLACK_BOT_TOKEN is unset, so views.open cannot be called.`

Editing needs no Slack app change and no reinstall.

## Repost reminders

Thirty minutes after a note goes out, amplifier checks whether anybody reposted it. If nobody
has, it replies in the thread and the reply also shows in the channel, so the ask is visible to
people who never opened the thread. The reminder carries its own Repost button, so it can be
acted on where it is read. `AMPLIFIER_REMINDER_MINUTES` sets the delay and `0` turns reminders
off. `AMPLIFIER_REMINDER_TEXT` sets the wording, and `{channel}` in it is replaced with
`AMPLIFIER_REPOST_CHANNEL`.

A click on the reminder's button behaves the same as a click on the note's. The receiver reads
the clicked message's `thread_ts`, so the reaction, the "Reposted by" reply and the reposted
marker all land on the note at the top of the thread.

Reminders need `AMPLIFIER_REPOST_CHANNEL`, because the reminder asks for the button in that
channel.

The check runs as its own workflow run, started through the Render API, so the Workflow service
needs `RENDER_API_KEY` and `WORKFLOW_SLUG` of its own on top of the ones the receiver has. The
delay is a sleep inside `amplifier.remindRepost`: the SDK has no way to schedule a run for later,
and holding the sleep in the announce run would mean a cancel or a deploy took the reminder with
it. Without those two variables a run logs that it skipped the dispatch, and the note gets no
reminder.

Whether a note was reposted is read from a Key Value marker `amplifier.repost` writes. Reading
the note's reactions instead would need a `reactions:read` scope and a raw Slack call. So a repost
done by hand, without the button, still gets a reminder. Anyone can delete the reminder.

A note gets one reminder. The reminded marker is written before the reply is posted, so two runs
for the same note produce one reply.

## Pinging a launch's owners

The note goes to the whole channel. The launch's owners get a DM as well, pointing at the thread
the note is in, so the people responsible for a post hear about it directly.

```
   note delivered to #amplify
        │
        ▼
┌────────────────────┐               ┌──────────────────────────┐
│ amplifier          │ ────────────▶ │ amplifier (Workflow)     │
│ announceGroups     │    ctx.run    │ amplifier.pingOwners     │
└────────────────────┘               └────────────┬─────────────┘
  1  notion.findLaunches ─────────────────────────┼──▶ Typefully, Notion
  2  read the pinged marker, then kv.lock ────────┼──▶ amplifier-kv
  3  notion.getPage ──────────────────────────────┼──▶ Notion API
  4  chat.getPermalink for the note ──────────────┼──▶ Slack
  5  lookupUser, then openDm, per owner ──────────┼──▶ Slack
  6  amplifier.postNote, one DM per owner ────────┼──▶ Slack DMs
  7  write the pinged marker, release the lock ───┴──▶ amplifier-kv
```

`announceGroups` runs this after every note it posts, so publication is the only trigger. That
task:

1. Finds the launch page from the group's Typefully draft, described in [From a post URL to its owners](#from-a-post-url-to-its-owners).
2. Stops when Key Value already records the page as pinged, so a re-announced draft DMs nobody twice. Pass `force: true` to send anyway.
3. Takes a 5-minute lock on the page, so two runs cannot both DM.
4. Reads the page through `notion.getPage` and pulls the owners and the title. A page with no Typefully URL, or with nobody in the owner property, is a skip rather than a failure, because that is the usual state of a launch page. A skip posts nothing and DMs nobody.
5. Asks Slack for the note's permalink with `chat.getPermalink`. Without one it DMs nobody and writes no marker, because a DM naming a thread it cannot link to is worse than no DM.
6. Turns each owner's Notion email into a Slack user id with `users.lookupByEmail`, opens a DM with `conversations.open`, and posts the DM through `amplifier.postNote`.
7. Records the page as pinged for 30 days, then releases the lock.

The DM carries the launch name, `AMPLIFIER_PING_ASK`, and the link to the thread:

```
Your *Origin is a supported Git provider* post is ready to amplify! Please click the Repost button in this thread

<https://renderinc.slack.com/archives/C…/p…|Open the thread>
```

The owner clicks **Repost to #<channel>** on the note in the channel, not in the DM. Anyone in
the channel can click it, so a colleague can step in when the owner misses it.

A failed ping is logged and never thrown. The note is already in the channel, so a Notion
database nobody configured does not cost the channel its announcement. Set
`AMPLIFIER_PING_OWNERS` to `false` to stop trying; the DMs are on whenever `NOTION_TOKEN` and
`NOTION_DATABASE_ID` are both set.

An owner with no Slack account under their Notion email gets no DM. Slack answers
`users_not_found`, and the run logs a `No DM for` line and lists that owner under `unreachable` in
its result. Nothing goes to Slack about them, so a failed DM never notifies the channel. The same
applies to an owner whose Notion page carries no email at all, and to a page with nobody in the
owner property. One owner failing never stops the others' DMs.

A page whose owners were all unreachable is left unmarked, so the next announcement of that draft
tries the DMs again.

`NOTION_TYPEFULLY_PROPERTY` and `NOTION_OWNERS_PROPERTY` name the two properties to read, because
Notion keys a page's properties by their display name. The match is case-insensitive, and a
property whose name contains the configured one matches too, so `Typefully` finds a column somebody
renamed to `Typefully URL`. The owner property is normally a people property. An email property, or
a text property holding addresses, is read as well.

The owner's email comes from the people property, which carries one only when the Notion
integration has the "Read user information, including email addresses" capability. Without it
Notion omits the field and returns no error, so every owner reads as having no email and every
launch ends in the channel note.

`NOTION_DATABASE_ID` is the launch database, and the run skips a page from anywhere else. For the
Render team it is the content database the DX team owns, whose Social Calendar view is the one
people work in.

The pinged marker is written after Slack accepts a DM, so a run that dies in the gap loses its
lock within 5 minutes and the next announcement of the same draft DMs the owners again.

### Pinging one launch by hand

`amplifier.pingOwners` also runs on its own, which is the route when a DM was missed. It needs the
note's channel id and the parent message's `ts`, both of which are in the note's Slack message
link: **···** > **Copy link** on the message gives
`https://renderinc.slack.com/archives/C09ABCDEF/p1758000000001100`, where `C09ABCDEF` is
`noteChannel` and `1758000000.001100` is `noteTs` with a decimal point six digits from the end.

```bash
render workflows start <slug>/amplifier.pingOwners \
  --input='[{"pageId":"2a1b3c4d5e6f4a8b9c0d1e2f3a4b5c6d","noteChannel":"C09ABCDEF","noteTs":"1758000000.001100","force":true}]'
```

`force: true` is what clears the pinged marker the first run wrote.

### From a post URL to its owners

The launch page carries a Typefully link, not a permalink, so the run gets from the announced draft
to the page in two hops:

1. `typefully.listPublished` turns the permalink into its draft, which carries the Typefully share
   URL. The newest 50 published drafts are searched, so an older post needs its `draftId`.
2. `notion.findLaunches` queries the launch database for a page whose Typefully property contains
   that share URL, its last path segment, or the draft id. The share URL wins when more than one
   page matches, and the run logs which page it chose.

The query goes to the database's first data source, because Notion 2025-09-03 splits a database
into data sources and only a data source can be queried. The filter names the Typefully property by
its exact display name, which comes from the data source's schema rather than from
`NOTION_TYPEFULLY_PROPERTY` directly, so the loose name match works here as well.

Nothing is DMed when no page carries the link. That is the normal state of a post somebody
published straight from Typefully without a launch page, so the run throws and names the share URL
it looked for, and `announceGroups` logs it.

A manual run takes a permalink as `url` instead, or the draft id as `draftId`.

## Configuration

| Variable                         | Default                     | Range | Notes                                                                                                                                                                                                                                                |
| -------------------------------- | --------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPEFULLY_API_KEY`              | —                           | —     | Required. Typefully Settings > Integrations.                                                                                                                                                                                                         |
| `TYPEFULLY_SOCIAL_SET_ID`        | —                           | —     | Required. `GET /v2/social-sets` lists them.                                                                                                                                                                                                          |
| `TYPEFULLY_BASE_URL`             | Typefully                   | —     | Local stub only. The API key is sent to whatever host this names, so only a loopback address is accepted. Leave it unset in production.                                                                                                              |
| `SLACK_BOT_TOKEN`                | —                           | —     | Required. The `xoxb-` bot token.                                                                                                                                                                                                                     |
| `SLACK_CHANNEL`                  | —                           | —     | Required. Channel the note goes to, with or without a leading `#`. Missing either this or the bot token fails the run.                                                                                                                               |
| `SLACK_API_BASE_URL`             | Slack                       | —     | Local stub only. The bot token, and a clicker's user token, are sent to whatever host this names, so only a loopback address is accepted. Leave it unset in production.                                                                              |
| `ANTHROPIC_API_KEY`              | —                           | —     | Required for the summary. Without it the note carries the fallback lead line.                                                                                                                                                                        |
| `REDIS_URL`                      | —                           | —     | Required. The `amplifier-kv` internal connection string.                                                                                                                                                                                             |
| `DRY_RUN`                        | `false`                     | —     | Set to exactly `true` to log the note instead of posting to Slack.                                                                                                                                                                                   |
| `AMPLIFIER_LOOKBACK_MINUTES`     | `90`                        | ≥ 1   | Covers the gap between the event and the run, plus any retry backoff.                                                                                                                                                                                |
| `AMPLIFIER_GROUP_WINDOW_MINUTES` | `10`                        | ≥ 0   | How close two drafts must be to share a note. `0` turns grouping off.                                                                                                                                                                                |
| `AMPLIFIER_SETTLE_MINUTES`       | `10`                        | 0–15  | How long a run waits for a platform's permalink before announcing without it. `0` turns settling off. The maximum is the retry budget on `amplifier.handleEvent`, past which the retries run out before the deadline and the event produces no note. |
| `AMPLIFIER_SEEN_TTL_DAYS`        | `30`                        | ≥ 1   | How long a draft stays marked as announced.                                                                                                                                                                                                          |
| `AMPLIFIER_LIMIT`                | `25`                        | 1–50  | Drafts pulled per run, and the run's widest burst of concurrent Key Value calls.                                                                                                                                                                     |
| `AMPLIFIER_CALL_TO_ACTION`       | see below                   | —     | The lead line used when the summary fails.                                                                                                                                                                                                           |
| `AMPLIFIER_SUMMARY_MODEL`        | `anthropic/claude-sonnet-5` | —     | The model that writes the lead line. The provider prefix is required. Takes precedence over `tasks-llm`'s own `LLM_MODEL`.                                                                                                                           |
| `NOTION_TOKEN`                   | —                           | —     | Required for the owner DMs. An internal integration secret, or an OAuth access token, from an integration with the user-email capability.                                                                                                            |
| `NOTION_TYPEFULLY_PROPERTY`      | `Typefully`                 | —     | Name of the launch page's URL property. Matched case-insensitively, and a longer name containing this one matches too.                                                                                                                               |
| `NOTION_OWNERS_PROPERTY`         | `Owner`                     | —     | Name of the launch page's people property. An email or text property is read too.                                                                                                                                                                    |
| `NOTION_DATABASE_ID`             | —                           | —     | The launch database. Unset means a page from any database the integration can see can ping, and no page can be found by post URL.                                                                                                                    |
| `NOTION_BASE_URL`                | Notion                      | —     | Local stub only. The token is sent to whatever host this names, so only a loopback address is accepted. Leave it unset in production.                                                                                                                |
| `AMPLIFIER_PING_ASK`             | see below                   | —     | The ask on the first line of an owner's DM.                                                                                                                                                                                                          |
| `AMPLIFIER_PING_OWNERS`          | see Notes                   | —     | Whether an announcement also DMs the launch's owners. On when `NOTION_TOKEN` and `NOTION_DATABASE_ID` are both set, off otherwise. Set it to `false` to turn the DMs off, or `true` to force them on.                                                |
| `AMPLIFIER_REMINDER_MINUTES`     | `30`                        | 0–35  | How long after a note amplifier reminds the channel that nobody reposted it. `0` turns reminders off. The maximum is the timeout on `amplifier.remindRepost`, which spends the delay as a sleep. See [Repost reminders](#repost-reminders).          |
| `AMPLIFIER_REMINDER_TEXT`        | see below                   | —     | The reminder's wording. `{channel}` in it is replaced with `AMPLIFIER_REPOST_CHANNEL`.                                                                                                                                                               |
| `RENDER_API_KEY`                 | —                           | —     | Required for reminders. Starts the reminder's own run. The same key the receiver has.                                                                                                                                                                |
| `WORKFLOW_SLUG`                  | —                           | —     | Required for reminders. The Workflow service's own slug, which it starts the reminder run against.                                                                                                                                                   |
| `AMPLIFIER_REPOST_CHANNEL`       | —                           | —     | Channel the Repost button posts to. Unset means no button and no stored note. Also required for reminders. See [Reposting](#reposting).                                                                                                              |
| `AMPLIFIER_REPOST_EMOJI`         | `white_check_mark`          | —     | Reaction added to a note that has been reposted. Must be an emoji the workspace has, or `reactions.add` answers `invalid_name`.                                                                                                                      |
| `SLACK_CLIENT_ID`                | —                           | —     | Needed for the user-token exchange. Slack app, Basic Information.                                                                                                                                                                                    |
| `SLACK_CLIENT_SECRET`            | —                           | —     | Needed for the user-token exchange. Read only by `amplifier.saveUserToken`, so it never reaches the receiver.                                                                                                                                        |
| `SLACK_SIGNING_SECRET`           | —                           | —     | Signs the authorize link's `state`. Must be the same value the receiver has, or the receiver rejects the link.                                                                                                                                       |
| `AMPLIFIER_PUBLIC_URL`           | —                           | —     | The receiver's base URL, such as `https://amplifier-webhook.onrender.com`. Required for the Repost button, because the Workflow service has no `RENDER_EXTERNAL_URL` of its own.                                                                     |

A numeric variable set to a fraction, to something non-numeric, or to a value outside
its range fails the run with the variable's name in the error. Every variable with a
value in the Default column uses that default when unset. The `AMPLIFIER_*` settings and
`DRY_RUN` also use their default when set to a blank value. The rows showing `—` have
no default.

Default call to action: "New Render social post! Please like and share when you have a minute"

Default ping ask: "Please click the Repost button in this thread"

Default reminder text: "This post still needs to be shared in #{channel}. The first hour matters most, so can the owner or another team member share it?"

Every variable above reaches the Workflow service through the `amplifier-workflow` env group, so set them there rather than on the service. You add most of them to the group by hand, in [deployment step 4](docs/deployment.md). `AMPLIFIER_SUMMARY_MODEL`, `AMPLIFIER_REPOST_EMOJI`, `NOTION_TYPEFULLY_PROPERTY` and `NOTION_OWNERS_PROPERTY` have literal values in `render.yaml`, so a Blueprint apply resets a Dashboard override of any of those four.

### Webhook receiver

The table above covers the Workflow service. These variables belong to the `amplifier-webhook` service. They reach it through the `amplifier-triggers` env group, so set them there rather than on the service. `render.yaml` gives the service only `fromGroup: amplifier-triggers`, and a variable added straight to the service is removed on the next Blueprint sync.

| Variable                   | Default               | Range | Notes                                                                                                                                             |
| -------------------------- | --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RENDER_API_KEY`           | —                     | —     | Required. Authenticates the dispatch call to the Render API.                                                                                      |
| `WORKFLOW_SLUG`            | —                     | —     | Required. Set by hand in the Dashboard to the Workflow service's slug, `amplifier` for the Render team. The receiver refuses to start without it. |
| `TYPEFULLY_WEBHOOK_SECRET` | —                     | —     | Required. The signing secret from Typefully, Settings > API. Unset means every delivery gets a 401.                                               |
| `SLACK_SIGNING_SECRET`     | —                     | —     | Verifies Repost clicks and signs the OAuth `state`. Unset means every Slack request gets a 401.                                                   |
| `SLACK_CLIENT_ID`          | —                     | —     | Builds the authorize link. The client secret does not belong here.                                                                                |
| `SLACK_BOT_TOKEN`          | —                     | —     | Required for the Edit button. The receiver opens the edit box itself, on a `trigger_id` that expires in three seconds.                            |
| `AMPLIFIER_PUBLIC_URL`     | `RENDER_EXTERNAL_URL` | —     | The receiver's own base URL, used to build the OAuth redirect. Only needed locally.                                                               |
| `PORT`                     | `3000`                | —     | Render sets this. Only needed to run the receiver locally.                                                                                        |

## License

MIT. See [LICENSE](LICENSE).
