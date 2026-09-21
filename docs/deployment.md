# Deploying Amplifier

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
   | `amplifier-workflow` | `NOTION_DATABASE_ID`      | The launch database's id, for the owner DMs            |
   | `amplifier-workflow` | `RENDER_API_KEY`          | The same key, for the repost reminder's own run        |
   | `amplifier-workflow` | `WORKFLOW_SLUG`           | The slug from step 2, for the same reason              |

   For Slack, add `SLACK_BOT_TOKEN` and `SLACK_CHANNEL`. Both are required. To turn the Repost button on, also add `AMPLIFIER_REPOST_CHANNEL`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` to `amplifier-workflow`, and `SLACK_CLIENT_ID` and `SLACK_SIGNING_SECRET` to `amplifier-triggers`. All four Slack values are on the app's Basic Information page. `AMPLIFIER_PUBLIC_URL` comes later, in step 6, because it is the receiver's own URL. The Edit button also needs `SLACK_BOT_TOKEN` in `amplifier-triggers`, because the receiver opens the edit box itself. See [Reposting](../README.md#reposting) and [Editing a note](../README.md#editing-a-note).

   `NOTION_TOKEN` and `NOTION_DATABASE_ID` are only needed for the owner DMs; leave them out if you only want the announce path. See [Pinging a launch's owners](../README.md#pinging-a-launchs-owners).

   `RENDER_API_KEY` and `WORKFLOW_SLUG` appear twice, once per group. The receiver uses them to start a run from a webhook delivery, and the Workflow service uses them to start the repost reminder's own run. Leave them out of `amplifier-workflow` if you do not want reminders; a run then logs that it skipped the dispatch and the note gets no reminder. See [Repost reminders](../README.md#repost-reminders).

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
   `https://notion.so/0123456789abcdef0123456789abcdef?v=39d751b483268049b220000c027ed883` gives
   `0123456789abcdef0123456789abcdef`. The `v=` part names a view, which amplifier does not read. A
   link copied from a row gives that row's page id instead, and `notion.findLaunches` then fails
   with a 404 naming `NOTION_DATABASE_ID`.
2. Add both values to the `amplifier-workflow` env group, as `NOTION_TOKEN` and
   `NOTION_DATABASE_ID`, and redeploy the Workflow service. `render.yaml` carries no id, because a
   literal there would overwrite the Dashboard value on every Blueprint sync. It reads the token on each call, but the redeploy is what puts the new variables on the
   running service.
3. Dry-run the ping against one real launch page, so you can read the owner lookups before a live
   post depends on them. It needs a note already in the channel to link to, so take the page id
   from the page's URL and the channel id and `ts` from any note's Slack message link, following
   [Pinging one launch by hand](../README.md#pinging-one-launch-by-hand):

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

To announce the post a Notion launch page names, open the page, copy its `Typefully` property,
and pass that share URL as `url`. `amplifier.announcePost` matches the share URL as well as the
platform permalinks.

Only the newest 50 published drafts are searched, so a post from weeks ago needs its `draftId`.

#### A whole window

When several posts were missed at once, run the scan instead:

```bash
render workflows start <slug>/amplifier.checkPosts --input='[{}]'
```

`amplifier.checkPosts` takes no event, so it scans the whole 90-minute lookback. The announced markers mean it posts what was missed and nothing else.

#### One launch's owners

`amplifier.pingOwners` takes the launch page and the note to link to. Its arguments and the run
itself are in [Pinging one launch by hand](../README.md#pinging-one-launch-by-hand).

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
[From a post URL to its owners](../README.md#from-a-post-url-to-its-owners). It needs `NOTION_DATABASE_ID`,
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

The manifest cannot carry the app icon. Upload `assets/bullhorn.png` under **Basic
Information > Display Information** after creating the app.

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
