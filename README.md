# Amplifier

Amplifier automates the process of sharing new LinkedIn and Twitter posts with the Render team. Whenever a post goes live on Twitter and/or LinkedIn, Amplifier sends a Slack note to the `#amplify` channel.

It reads published drafts from Typefully, which is where the Render Twitter and LinkedIn accounts are scheduled. A post sent to both platforms produces one Slack thread, with a link per platform as a reply. Anyone in the channel can click Repost on that thread to post it again in a second channel, as themselves.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Ho1yShif/amplifier)

The button applies `render.yaml`, which covers the webhook receiver, the Key Value instance,
and the env groups. It does not create the Workflow service, because Blueprints do not support
Workflows yet. Read [Deployment](#deployment) first; the button is step 5.

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

`render.yaml` covers the webhook receiver, the Key Value instance, and the env groups. The Workflow
service is created separately, because Blueprints do not support Workflow services yet. Applying a
Blueprint and giving a workspace access to a private repo both happen in the Render Dashboard;
neither has an API or CLI path. Give the workspace that will own the project access to this repo
first, under Settings > GitHub, because Render cannot clone a private repo until then.

For the Render team, the workspace is Render-DX and steps 2 and 3 are done: workflow `amplifier`,
region Oregon, built from `main`.

1. Create the Slack app and copy a credential, following [Slack credentials](#slack-credentials) below. Nothing in Render has to exist first, and step 4 needs the credential.
2. Create the Workflow service, following [Creating the Workflow service](#creating-the-workflow-service) below. Note the slug it prints.
3. Run `render workflows start <slug>/ping --input='[]'` to confirm the task registry loaded, before any secret is set. `ping` takes no arguments, so the input array is empty, and it returns `pong`. If the task list is empty, the build shipped but `dist/main.js` registered nothing, and the deploy logs say why.
4. Create the two env groups in the Dashboard, under Env Groups, and add the keys below. Do this before applying the Blueprint. `sync: false` is ignored inside an env var group, so the apply never prompts for these, and a receiver whose `RENDER_API_KEY` is empty exits at startup with `RenderError: API token is required`. A receiver whose `WORKFLOW_SLUG` is empty exits the same way, naming the variable.

   | Group                | Key                       | Value                                                  |
   | -------------------- | ------------------------- | ------------------------------------------------------ |
   | `amplifier-triggers` | `RENDER_API_KEY`          | A key for the workspace that owns the Workflow service |
   | `amplifier-triggers` | `WORKFLOW_SLUG`           | The slug from step 2                                   |
   | `amplifier-triggers` | `SLACK_BOT_TOKEN`         | The `xoxb-` token, for the Edit button                 |
   | `amplifier-workflow` | `ANTHROPIC_API_KEY`       | An Anthropic API key                                   |
   | `amplifier-workflow` | `TYPEFULLY_API_KEY`       | Typefully Settings > Integrations                      |
   | `amplifier-workflow` | `TYPEFULLY_SOCIAL_SET_ID` | `GET /v2/social-sets` lists them                       |
   | `amplifier-workflow` | `SLACK_BOT_TOKEN`         | See below                                              |
   | `amplifier-workflow` | `SLACK_CHANNEL`           | The channel the notes go to                            |
   | `amplifier-workflow` | `NOTION_TOKEN`            | Integration token, for the owner DMs                   |
   | `amplifier-workflow` | `RENDER_API_KEY`          | The same key, for the repost reminder's own run        |
   | `amplifier-workflow` | `WORKFLOW_SLUG`           | The slug from step 2, for the same reason              |

   For Slack, add `SLACK_BOT_TOKEN` and `SLACK_CHANNEL`. Both are required. To turn the Repost button on, also add `AMPLIFIER_REPOST_CHANNEL`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` to `amplifier-workflow`, and `SLACK_CLIENT_ID` and `SLACK_SIGNING_SECRET` to `amplifier-triggers`. All four Slack values are on the app's Basic Information page. `AMPLIFIER_PUBLIC_URL` comes later, in step 6, because it is the receiver's own URL. The Edit button also needs `SLACK_BOT_TOKEN` in `amplifier-triggers`, because the receiver opens the edit box itself. See [Reposting](#reposting) and [Editing a note](#editing-a-note).

   `NOTION_TOKEN` is only needed for the owner DMs; leave it out if you only want the announce path. See [Pinging a launch's owners](#pinging-a-launchs-owners).

   `RENDER_API_KEY` and `WORKFLOW_SLUG` appear twice, once per group. The receiver uses them to start a run from a webhook delivery, and the Workflow service uses them to start the repost reminder's own run. Leave them out of `amplifier-workflow` if you do not want reminders; a run then logs that it skipped the dispatch and the note gets no reminder. See [Repost reminders](#repost-reminders).

   Both services hold a key that can do anything in the workspace, because Render API keys are not scoped to one service. Amplifier only ever starts a run on its own workflow slug. Issue the key from a Render account with access to this workspace alone, and rotate it in both groups together.

   `TYPEFULLY_WEBHOOK_SECRET` belongs in `amplifier-triggers` too, but Typefully does not show it until step 11, so leave it out for now. Leave `AMPLIFIER_SUMMARY_MODEL` out as well; `render.yaml` gives it a literal value and the apply adds it to `amplifier-workflow`. `REDIS_URL` comes later, in step 9, because `amplifier-kv` does not exist yet. Nothing here can use `generateValue`; every value is one you paste in.

5. Apply `render.yaml`, with the Deploy to Render button above or from the Dashboard, to create the `amplifier-webhook` service and the Key Value instance, and to link `amplifier-triggers` to the receiver. The apply asks for no values, because step 4 set them all.
6. Point the Slack app at the receiver, now that it has a hostname, following [Interactivity and the OAuth redirect](#interactivity-and-the-oauth-redirect). It sets the two Slack URLs and adds `AMPLIFIER_PUBLIC_URL` to `amplifier-workflow`. Skip this step if you are not using the Repost button.
7. Confirm `amplifier-kv` landed in region Oregon. `render.yaml` names Oregon, so it should. The Workflow service reaches it over the private network as long as both are in Oregon in the same workspace; the project and the environment do not have to match.
8. On the Workflow service, link the `amplifier-workflow` env group. The group holds every variable the Workflow service reads, and it is linked in the Dashboard because Blueprints do not support Workflow services, so `render.yaml` cannot reference it.
9. Add `REDIS_URL` to `amplifier-workflow`, set to the `amplifier-kv` internal connection string from its Dashboard page. Do not copy the value from `.env` or `.env.example`; those hold `redis://localhost:6379` for local dev, and on Render nothing listens there. A run using it fails every Key Value task with repeated `[ioredis] Unhandled error event: AggregateError [ECONNREFUSED]` and `Reached the max retries per request limit (which is 20)`.
10. Confirm the link took: the Workflow service's environment page lists `AMPLIFIER_SUMMARY_MODEL` with the value `anthropic/claude-sonnet-5` from the group. If it does not, the group exists but is not linked, and every note will carry `(Summarization LLM call failed)`.
11. Register the receiver in Typefully, following [Registering the Typefully webhook](#registering-the-typefully-webhook) below.
12. Add `DRY_RUN=true` to `amplifier-workflow`, publish a couple of posts, and read the Workflow logs. The parent is logged after `[dry run] would post:` and each threaded link after `[dry run] would reply:`, in the order a real run would send them. Check the thread shape here before the first real note.
13. Remove `DRY_RUN` from `amplifier-workflow` so runs post to Slack.
14. Create the Notion integration, following [Notion integration](#notion-integration) below. Skip this step if you only want the channel note and no owner DMs.

### Creating the Workflow service

Use the Render CLI, version 2.26.0 or newer, from a checkout of this repo. First pick the workspace
that owns the project:

```bash
render workspace set
```

Then create the service:

```bash
render workflows create \
  --name amplifier \
  --repo . \
  --branch main \
  --runtime node \
  --region oregon \
  --build-command 'npm install -g pnpm@11.18.0 && pnpm install && pnpm build' \
  --run-command 'node dist/main.js'
```

Or in the Dashboard, choose **New > Workflow**, pick this repo, and fill in the form:

| Field          | Value                                                       |
| -------------- | ----------------------------------------------------------- |
| Name           | `amplifier`                                                 |
| Branch         | `main`                                                      |
| Region         | Oregon                                                      |
| Language       | Node                                                        |
| Root Directory | leave blank                                                 |
| Build Command  | `npm install -g pnpm@11.18.0 && pnpm install && pnpm build` |
| Start Command  | `node dist/main.js`                                         |

Then click **Deploy Workflow**.

The build command installs pnpm first. Render's Node runtime ships npm, and `package.json` pins
`pnpm@11.18.0`, so `pnpm install` fails without that line.

Region Oregon matches `amplifier-kv` in `render.yaml`. The private network covers one region within
one workspace, so a Workflow service in any other region cannot reach the Key Value instance. Keep
the service out of a network-isolated environment as well, because a Workflow service in one cannot
reach anything over that environment's private network.

The Workflow service reads its variables from the `amplifier-workflow` env group, linked in step 8,
so `render workflows create` needs no `--env-var` or `--env-file` flags.

### Registering the Typefully webhook

1. In the Render Dashboard, copy the `amplifier-webhook` service's `onrender.com` URL and append `/webhooks/typefully`.
2. Open <https://typefully.com/?settings=api> and click **Add webhook**.
3. Paste the URL, select the `draft.published` event, and save.
4. Typefully now shows a signing secret. Add a new key to the `amplifier-triggers` env group, named `TYPEFULLY_WEBHOOK_SECRET`, and paste the secret as its value. The key does not exist yet, because Typefully creates the secret only when you save the webhook, so deployment step 4 could not add it.
5. Redeploy `amplifier-webhook`. It reads `TYPEFULLY_WEBHOOK_SECRET` at startup, so it rejects every delivery until it restarts with the new value.

### Notion integration

Every call sends `NOTION_TOKEN` as a bearer token, and Notion's two kinds of integration both
produce one, so create whichever kind you can and then follow
[Database id and first run](#database-id-and-first-run) for the rest.

An internal integration is the shorter path, and creating one requires the workspace that holds the
launch database to allow it. An OAuth integration lives in a workspace you control, and whoever
authorizes it grants access to pages they can already see, so it is the path when the launch
database's workspace is not yours to configure.

#### Internal integration

1. Open <https://notion.so/profile/integrations> and click **New integration**. Name it, pick the
   workspace that holds the launch database, and set its type to **Internal**.
2. On the integration's **Configuration** tab, under **Capabilities**, check **Read content** and
   set user capabilities to **Read user information, including email addresses**. Without the email
   capability the owner property carries no email, and nobody can be DMed. Save.
3. Still on **Configuration**, under **Internal Integration Secret**, click **Show** and then
   **Copy**. The value starts with `ntn_`. This is `NOTION_TOKEN`. Notion shows it to anyone who can
   open the integration, so treat it as a password and do not paste it into a file you commit.
4. Connect the integration to the launch database, from the database's **···** menu >
   **Connections** > the integration's name. A page the integration is not connected to answers 404,
   and `amplifier.pingOwners` fails.

#### OAuth integration

Notion calls this a public integration. The authorization hands back an access token that works
wherever an internal secret works, so the extra work is the one-time exchange in steps 5 to 7.
Amplifier has no Notion callback route, so you do that exchange by hand with `curl`.

1. Open <https://notion.so/profile/integrations> and click **New connection**. Name it and set the
   **Redirect URI**. Amplifier has no route to receive the code, so point it at a path on the
   receiver that answers 404, such as `<receiver>/notion/oauth/callback`. A 404 still leaves the
   code in the browser's address bar, which is all step 6 needs. Notion requires https here, so the
   deployed receiver is the easiest host to name. Click **Create Connection**.
2. On the **Configuration** tab, under **Capabilities**, check **Read content** in the **Content
   capabilities** section and uncheck **Update content** and **Insert content**. Set user
   capabilities to **Read user information, including email addresses**. Without the email
   capability the owner property carries no email, and nobody can be DMed.
3. Fill in the company name, website, privacy policy URL, terms of use URL and support email that
   Notion asks for. It withholds the OAuth credentials until all of them are set.
4. Copy the **OAuth client ID** and **OAuth client secret**. The secret is a password; it authorizes
   the exchange in step 7.
5. Open the authorize URL in a browser, with the redirect URI percent-encoded:

   ```
   https://api.notion.com/v1/oauth/authorize?client_id=<client id>&response_type=code&owner=user&redirect_uri=<redirect uri>
   ```

   Pick the workspace that holds the launch database, click **Select pages**, choose the launch
   database, and approve. This grant is what the internal path does from the **Connections** menu.
   The integration sees the pages you select here and nothing else, and you can only select pages
   you can see yourself.

6. The browser lands on the redirect URI with `?code=...` on the end. Copy that code. It is
   single-use and expires within minutes, so run the next step straight away.
7. Exchange the code for a token:

   ```bash
   curl -X POST https://api.notion.com/v1/oauth/token \
     -u '<client id>:<client secret>' \
     -H 'Content-Type: application/json' \
     -d '{"grant_type":"authorization_code","code":"<code>","redirect_uri":"<redirect uri>"}'
   ```

   The `access_token` in the reply is `NOTION_TOKEN`. Treat it as a password, the same as an
   internal secret. The reply also names the workspace and the bot user the grant created. If it
   carries a `refresh_token` or an expiry, the token is not permanent, and amplifier has no refresh
   path, so renewing it means running steps 5 to 7 again.

Re-run steps 5 to 7 to add a page the grant does not cover, or add it from the database's **···** >
**Connections** menu, which works for either kind of integration.

#### Database id and first run

1. Copy the launch database's id. Open the database as a full page and take the 32 hex characters
   in the URL before the `?`, so
   `https://notion.so/7dabf9f3eeb64800bdf6b919611ff771?v=39d751b483268049b220000c027ed883` gives
   `7dabf9f3eeb64800bdf6b919611ff771`. The `v=` part names a view, which amplifier does not read. A
   link copied from a row gives that row's page id instead, and `notion.findLaunches` then fails
   with a 404 naming `NOTION_DATABASE_ID`. `render.yaml` already carries the Render content
   database's id, so the Render team can skip this step and check the value the Blueprint set.
2. Add the token to the `amplifier-workflow` env group as `NOTION_TOKEN`, along with
   `NOTION_DATABASE_ID` if you are not using the id from `render.yaml`, and redeploy the Workflow
   service. It reads the token on each call, but the redeploy is what puts the new variables on the
   running service.
3. Dry-run the ping against one real launch page, so you can read the owner lookups before a live
   post depends on them. It needs a note already in the channel to link to, so take the page id
   from the page's URL and the channel id and `ts` from any note's Slack message link, following
   [Pinging one launch by hand](#pinging-one-launch-by-hand):

   ```bash
   render workflows start <slug>/amplifier.pingOwners \
     --input='[{"pageId":"<page id>","noteChannel":"<channel id>","noteTs":"<ts>","dryRun":true}]'
   ```

   The Workflow logs show one `[dry run] would DM` line per owner amplifier could reach, and a
   `No DM for` line naming each owner it could not. An owner listed there whose Notion page does
   have an email means the integration is missing the email capability, or that person has no
   Slack account under that address. A dry run sends nothing, so it writes no pinged marker
   and the page still pings for real later.

### Manual trigger

The webhook is the only trigger, so a dropped delivery means a post nobody announces.

#### One post

`amplifier.announcePost` takes the permalink you have in front of you:

```bash
render workflows start <slug>/amplifier.announcePost \
  --input='[{"url":"https://x.com/render/status/2097716776390058019"}]'
```

The Dashboard route is the same task from the Workflow service's **Tasks** tab, pasting the same JSON array. The array is the task's positional arguments, so a single object in an array is the shape.

| Field          | What it does                                            |
| -------------- | ------------------------------------------------------- |
| `url`          | Permalink to the live post, or its Typefully share URL. |
| `draftId`      | Typefully draft id, when the URL is not to hand.        |
| `force`        | Re-post a draft that was already announced.             |
| `dryRun`       | Log the note instead of posting it.                     |
| `slackChannel` | Channel the note goes to.                               |

`dryRun: true` prints the note after `[dry run] would post:` in the run's logs and writes no marker, so the real run still has the post to announce.

Only the newest 50 published drafts are searched, so a post from weeks ago needs its `draftId`.

#### A whole window

When several posts were missed at once, run the scan instead:

```bash
render workflows start <slug>/amplifier.checkPosts --input='[{}]'
```

`amplifier.checkPosts` takes no event, so it scans the whole 90-minute lookback. The announced markers mean it posts what was missed and nothing else.

#### One launch's owners

`amplifier.pingOwners` takes the launch page and the note to link to. Its arguments and the run
itself are in [Pinging one launch by hand](#pinging-one-launch-by-hand).

| Field         | What it does                                                     |
| ------------- | ---------------------------------------------------------------- |
| `pageId`      | The Notion page to read. One of `pageId`, `url` or `draftId`.    |
| `url`         | Permalink to the live post, or its Typefully share URL.          |
| `draftId`     | Typefully draft id, when the URL is not to hand.                 |
| `noteChannel` | Channel id of the note the DM links to. Required, with `noteTs`. |
| `noteTs`      | The note's `ts`. Without both of these the run DMs nobody.       |
| `force`       | DM the owners again for a page already marked pinged.            |
| `dryRun`      | Log each DM instead of sending it.                               |

`dryRun: true` still reads the page, resolves the note's permalink and looks up each owner, so the
logs say who would be DMed and who could not be found. It sends nothing and writes no marker.

A `url` or a `draftId` reaches the page in two hops, described in
[From a post URL to its owners](#from-a-post-url-to-its-owners). It needs `NOTION_DATABASE_ID`,
because there is no other way to know which database to search.

### Security

The receiver's URL is public, and a signature check is the only thing gating each route.

A Typefully delivery whose HMAC-SHA256 signature does not match `TYPEFULLY_WEBHOOK_SECRET` gets a 401 and starts no run, and so does one whose timestamp is more than 15 minutes from the receiver's clock.

The receiver has no Notion route. The owner DMs run inside the announce path, so nothing on the internet can start a ping. `NOTION_DATABASE_ID` limits which pages a run will read, because a page from any other database is skipped before a DM goes out, as long as the page reports a `database_id`.

`POST /slack/interactivity` recomputes Slack's own HMAC-SHA256 over `v0:{timestamp}:{body}` with `SLACK_SIGNING_SECRET` and rejects a timestamp more than five minutes from the clock. `GET /slack/oauth/callback` takes no signature, so the `state` on the authorize link carries the clicker's user id plus an expiry, HMAC-signed with the same secret. Without that signature anyone could complete the callback and have their own token stored under someone else's id.

`POST /tasks/:task` stays shut because `DISPATCH_TOKEN` is unset, which makes that route answer 401 to everything. Do not set it.

## Slack credentials

Pick the Slack channel the notes will go to. If the production channel is busy, use a test channel first.

`slack-app-manifest.yaml` defines the app. At <https://api.slack.com/apps>, choose
**Create New App > From a manifest > Continue**, pick the workspace, and paste the file as YAML. Click **Next > Create and Install**.

The manifest requests `chat:write`, `reactions:write`, `users:read`, `users:read.email` and
`im:write` for the bot, and `chat:write` for a user. `users:read.email` and `im:write` let
`amplifier.pingOwners` find an owner from their email and DM them, and Slack only grants
`users:read.email` alongside `users:read`. Drop all three if you only want the announce path. To change the app later, edit the file and paste it into **App Manifest** on the
app's settings page. A scope change requires a reinstall. Check the Bot User OAuth Token
afterwards and update `SLACK_BOT_TOKEN` if it changed.

The two URLs in the manifest point at the `amplifier-webhook` receiver, which does not
exist until the Blueprint is applied. Deployment step 6 fills them in.

Copy these into the env groups in deployment step 4:

- **`SLACK_BOT_TOKEN`** is the `xoxb-` token on **OAuth & Permissions**. Goes in both
  groups, with the same value: `amplifier-workflow` posts the notes with it, and the
  receiver opens the edit box with it. `/invite` the bot to the channel first.
- **`SLACK_CHANNEL`** is the channel the notes go to. Goes in `amplifier-workflow`. The
  leading `#` is optional. If the production channel is busy, use a test channel first.
- **`SLACK_SIGNING_SECRET`** is on **Basic Information**. Goes in both groups, with the same
  value. The receiver verifies Repost clicks, Edit clicks and saved edits with it, and
  `amplifier.repost` signs the authorize link's `state` with it.
- **`SLACK_CLIENT_ID`** and **`SLACK_CLIENT_SECRET`** are on **Basic Information** too.
  The id goes in both groups; the secret goes in `amplifier-workflow` only, because
  `amplifier.saveUserToken` is the only thing that reads it.

Both `SLACK_BOT_TOKEN` and `SLACK_CHANNEL` are required. Without either,
`amplifier.postNote` throws and the run ends `failed`. That is deliberate: a run that
cannot post must not report success. Threading needs the parent message's `ts`, and only
the Web API route returns one.

The token is minted during install, so it cannot be committed alongside the manifest.

### Interactivity and the OAuth redirect

The Repost button needs two URLs on the Slack app, and both point at the deployed
`amplifier-webhook` receiver. Do this after the Blueprint apply, because the receiver's
hostname does not exist before then.

`<receiver>` below is that service's public URL. Open `amplifier-webhook` in the Render
Dashboard and copy the URL at the top of its page. It reads
`https://amplifier-webhook.onrender.com` unless the name was already taken, in which case
Render appends a suffix and it reads something like
`https://amplifier-webhook-a1b2.onrender.com`. Use whatever the Dashboard shows, with no
trailing slash. `<receiver>/healthz` answering 200 confirms you have the right
host.

1. Open the app at <https://api.slack.com/apps> and go to **Interactivity & Shortcuts**.
   Turn **Interactivity** on, set **Request URL** to `<receiver>/slack/interactivity`, and
   click **Save Changes**. This is the URL Slack posts to when someone clicks Repost or Edit,
   and when someone saves an edit.
2. Go to **OAuth & Permissions > Redirect URLs**, click **Add New Redirect URL**, enter
   `<receiver>/slack/oauth/callback`, then click **Add** and **Save URLs**. Slack compares
   this against the redirect on the authorize link character for character, so use https
   and no trailing slash.
3. On the same page, check both scope lists against the manifest. **Bot Token Scopes** needs
   `chat:write`, `reactions:write`, `users:read`, `users:read.email` and `im:write`. **User
   Token Scopes** needs `chat:write`, because a repost posts as the person who clicked. Click
   **Add an OAuth Scope** for any that is missing. Slack adds `users:read` for you when you
   pick `users:read.email`, and refuses the email scope without it. An app installed before
   these scopes were added does not have them, and without `users:read.email` or `im:write`
   `amplifier.pingOwners` reaches nobody.
4. If either scope list changed, click **Reinstall to <WORKSPACE-NAME>** at the top of the
   page. The new scope takes effect on the existing installation. Compare the **Bot User
   OAuth Token** against `SLACK_BOT_TOKEN` in the `amplifier-workflow` Environment Group:
   Slack usually returns the same `xoxb-` value, and then there is nothing to change. If it
   did change, paste the new one in and redeploy `amplifier-workflow`.
5. Set the environment variables the button needs. In the Render Dashboard the two env
   groups are under **Env Groups**. `amplifier-triggers` gets `SLACK_CLIENT_ID`,
   `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`. `amplifier-workflow` gets the client id
   and the signing secret too, plus `SLACK_CLIENT_SECRET`, `AMPLIFIER_REPOST_CHANNEL`, and
   `AMPLIFIER_PUBLIC_URL`. Redeploy both services afterwards. Where each value comes from:

   - `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` are all on the
     Slack app's **Basic Information** page, under **App Credentials**. The secret and the
     signing secret are hidden until you click **Show**. The client id and the signing
     secret go in both groups, with the same value in each.
   - `AMPLIFIER_REPOST_CHANNEL` is the channel reposts go to, which you pick. It is not
     the channel the notes are posted in.
   - `AMPLIFIER_PUBLIC_URL` is `<receiver>`, the same URL you used in steps 1 and 2. The
     Workflow service builds the authorize link and has no external URL of its own.

6. Post a cross-post note and click **Repost to #<channel>**. The first click answers
   privately with an authorize link. Approve it, click Repost again, and the thread should
   appear in the repost channel under your own name.

Slack does not check the Request URL when you save it, so a wrong URL shows up only on the
first click. Four failures to tell apart:

- Slack shows a warning in the channel and nothing else happens. The receiver did not
  answer 200 within three seconds. Check that it is deployed and that the Request URL has
  no typo.
- The click is answered with "Ask the amplifier owner to set..." The Workflow service is
  missing `SLACK_CLIENT_ID`, `SLACK_SIGNING_SECRET`, or `AMPLIFIER_PUBLIC_URL`.
- The authorize link ends on Slack's `bad_redirect_uri` page. The redirect URL in step 2
  does not match `AMPLIFIER_PUBLIC_URL` exactly.
- The repost lands and the "Reposted by" reply appears, but the source note gets no check
  mark. The bot token has no `reactions:write`, and `amplifier.repost` logs
  `reactions.add error: missing_scope` rather than failing the click. Add the scope in step
  3 and follow step 4. The reaction goes through `SLACK_RETRY`, so it spends about eighteen
  seconds retrying a failure that will never clear, which is why the confirmation is slow.

To test against a local receiver, put a tunnel in front of it and use the tunnel's
hostname in steps 1, 2 and 5. Slack has to reach the receiver from the internet.

### Migrating an existing deployment

The incoming-webhook path is gone, so a deployment that used `SLACK_WEBHOOK_URL` needs four changes:

1. Paste the updated `slack-app-manifest.yaml` into the Slack app and reinstall it. Check the Bot User OAuth Token afterwards and update `SLACK_BOT_TOKEN` if it changed.
2. Remove `SLACK_WEBHOOK_URL` from `amplifier-workflow`, and confirm `SLACK_BOT_TOKEN` and `SLACK_CHANNEL` are both set and the bot is in the source channel.
3. Set the Slack app's Interactivity Request URL and OAuth Redirect URL, following [Interactivity and the OAuth redirect](#interactivity-and-the-oauth-redirect), if you want the Repost button.
4. Redeploy both services.

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

Every variable above reaches the Workflow service through the `amplifier-workflow` env group, so set them there rather than on the service. You add most of them to the group by hand, in step 4. `AMPLIFIER_SUMMARY_MODEL`, `AMPLIFIER_REPOST_EMOJI`, `NOTION_TYPEFULLY_PROPERTY`, `NOTION_OWNERS_PROPERTY` and `NOTION_DATABASE_ID` have literal values in `render.yaml`, so a Blueprint apply resets a Dashboard override of any of those five.

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
