import { DEFAULT_PING_ASK } from "./amplifier/pingTemplate.js";
import { DEFAULT_REMINDER_TEXT } from "./amplifier/remindTemplate.js";
import { MAX_REMINDER_MINUTES, MAX_SETTLE_MINUTES } from "./amplifier/retry.js";
import { DEFAULT_CALL_TO_ACTION } from "./amplifier/template.js";
import { DEFAULT_SUMMARY_MODEL } from "./summary/model.js";
import { SECONDS_PER_DAY } from "./time.js";

/** Overrides accepted per run; anything omitted falls back to env, then defaults. */
export interface CheckPostsInput {
  socialSetId?: string;
  limit?: number;
  lookbackMinutes?: number;
  groupWindowMinutes?: number;
  settleMinutes?: number;
  seenTtlDays?: number;
  slackChannel?: string;
  callToAction?: string;
  /** Provider-prefixed model id for the summary, e.g. "anthropic/claude-sonnet-5". */
  summaryModel?: string;
  /** Channel the Repost button posts to. Absent means the note carries no button. */
  repostChannel?: string;
  dryRun?: boolean;
  /** ISO 8601 "now", for tests and for replaying a past window. */
  now?: string;
  /** ISO 8601 time the webhook event was received. Absent means do not settle. */
  eventAt?: string;
  /** Typefully draft the event was about. Absent means do not settle. */
  draftId?: string;
}

export interface AmplifierConfig {
  socialSetId?: string;
  limit: number;
  lookbackMinutes: number;
  groupWindowMinutes: number;
  settleMinutes: number;
  seenTtlSeconds: number;
  slackChannel?: string;
  callToAction: string;
  summaryModel: string;
  dryRun: boolean;
  /** Channel the Repost button posts to. Absent means no button and no repost. */
  repostChannel?: string;
  /** Reaction the repost task adds to the source parent. */
  repostEmoji: string;
  /** Slack app credentials for the user-token exchange. Absent means nobody can authorize. */
  slackClientId?: string;
  slackClientSecret?: string;
  /** Display name of the Notion property holding a launch's Typefully link. */
  notionTypefullyProperty: string;
  /** Display name of the Notion property naming a launch's owners. */
  notionOwnersProperty: string;
  /** Launch database id. Absent means a page from any database can ping. */
  notionDatabaseId?: string;
  /** The ask in an owner's DM. */
  pingAsk: string;
  /** Whether an announcement also DMs the launch's owners. */
  pingOwners: boolean;
  /** Minutes between a note and its repost reminder. 0 means no reminder. */
  reminderMinutes: number;
  /** The reminder's text, with CHANNEL_PLACEHOLDER for the repost channel. */
  reminderText: string;
}

/**
 * Names of the two properties `amplifier.pingOwners` reads, used when nothing
 * overrides them.
 *
 * Notion keys a page's properties by display name, so these are settings and
 * not constants. `readLaunch` also matches a property whose name contains the
 * configured one, so `Typefully` finds a column named `Typefully URL`.
 */
export const DEFAULT_TYPEFULLY_PROPERTY = "Typefully";
export const DEFAULT_OWNERS_PROPERTY = "Owner";

/**
 * Reaction added to a note that has been reposted.
 *
 * `white_check_mark` and not `check`, because `check` is a custom emoji in most
 * workspaces and `reactions.add` answers `invalid_name` when it is missing.
 */
export const DEFAULT_REPOST_EMOJI = "white_check_mark";

/**
 * Most drafts one run may pull, and so the widest burst of concurrent Key Value
 * subtasks a run can open. `announcedDraftIds` and `markAnnounced` dispatch one
 * `ctx.run` per draft at once, so the limit and the burst are the same number.
 *
 * Capped at 50 because Typefully rejects a larger `limit` with a 422.
 */
export const MAX_LIMIT = 50;

/** Drafts pulled per run when nothing overrides it. Also listPublished's own fallback. */
export const DEFAULT_LIMIT = 25;

interface Bounds {
  /** Used when the override is absent and the environment variable is unset or blank. */
  fallback: number;
  min: number;
  max?: number;
}

/**
 * Resolve run config from per-run overrides, then environment, then defaults.
 *
 * DRY_RUN defaults to false, so a run posts to Slack. Set it to exactly "true"
 * to log the note the run would post and write nothing.
 *
 * The lookback default of 90 minutes covers the gap between the webhook event
 * and the run, plus any retry backoff, and it is wide enough that a manual
 * re-run catches a post whose delivery was dropped. The announced marker in Key
 * Value keeps the overlapping runs from re-posting what is already out.
 */
export function loadConfig(
  input: CheckPostsInput = {},
  env: NodeJS.ProcessEnv = process.env,
): AmplifierConfig {
  const socialSetId = input.socialSetId ?? env.TYPEFULLY_SOCIAL_SET_ID;
  const slackChannel = channelName(input.slackChannel ?? env.SLACK_CHANNEL);
  const repostChannel = channelName(input.repostChannel ?? env.AMPLIFIER_REPOST_CHANNEL);
  const slackClientId = optional(env.SLACK_CLIENT_ID);
  const slackClientSecret = optional(env.SLACK_CLIENT_SECRET);
  const notionDatabaseId = optional(env.NOTION_DATABASE_ID);
  const seenTtlDays = whole(
    "AMPLIFIER_SEEN_TTL_DAYS",
    env.AMPLIFIER_SEEN_TTL_DAYS,
    { fallback: 30, min: 1 },
    input.seenTtlDays,
  );

  return {
    ...(socialSetId ? { socialSetId } : {}),
    limit: whole(
      "AMPLIFIER_LIMIT",
      env.AMPLIFIER_LIMIT,
      { fallback: DEFAULT_LIMIT, min: 1, max: MAX_LIMIT },
      input.limit,
    ),
    lookbackMinutes: whole(
      "AMPLIFIER_LOOKBACK_MINUTES",
      env.AMPLIFIER_LOOKBACK_MINUTES,
      { fallback: 90, min: 1 },
      input.lookbackMinutes,
    ),
    // A group window of 0 groups only drafts published at the same instant.
    // Set it to 0 to turn grouping off.
    groupWindowMinutes: whole(
      "AMPLIFIER_GROUP_WINDOW_MINUTES",
      env.AMPLIFIER_GROUP_WINDOW_MINUTES,
      { fallback: 10, min: 0 },
      input.groupWindowMinutes,
    ),
    // A settle window of 0 announces whatever links exist on the first attempt.
    // Set it to 0 to turn settling off. The maximum is the retry budget on
    // amplifier.handleEvent, past which the retries run out before the deadline
    // and the event produces no note at all.
    settleMinutes: whole(
      "AMPLIFIER_SETTLE_MINUTES",
      env.AMPLIFIER_SETTLE_MINUTES,
      { fallback: 10, min: 0, max: MAX_SETTLE_MINUTES },
      input.settleMinutes,
    ),
    seenTtlSeconds: seenTtlDays * SECONDS_PER_DAY,
    ...(slackChannel ? { slackChannel } : {}),
    callToAction: text(env.AMPLIFIER_CALL_TO_ACTION, DEFAULT_CALL_TO_ACTION, input.callToAction),
    summaryModel: text(env.AMPLIFIER_SUMMARY_MODEL, DEFAULT_SUMMARY_MODEL, input.summaryModel),
    dryRun: input.dryRun ?? env.DRY_RUN === "true",
    ...(repostChannel ? { repostChannel } : {}),
    repostEmoji: text(env.AMPLIFIER_REPOST_EMOJI, DEFAULT_REPOST_EMOJI),
    ...(slackClientId ? { slackClientId } : {}),
    ...(slackClientSecret ? { slackClientSecret } : {}),
    notionTypefullyProperty: text(env.NOTION_TYPEFULLY_PROPERTY, DEFAULT_TYPEFULLY_PROPERTY),
    notionOwnersProperty: text(env.NOTION_OWNERS_PROPERTY, DEFAULT_OWNERS_PROPERTY),
    ...(notionDatabaseId ? { notionDatabaseId } : {}),
    pingAsk: text(env.AMPLIFIER_PING_ASK, DEFAULT_PING_ASK),
    // On by default once Notion is configured, because an announcement whose
    // owners hear nothing is the thing this exists to fix. Both variables are
    // needed: the token reads the page and the database id finds it from the
    // draft.
    pingOwners: flag(
      "AMPLIFIER_PING_OWNERS",
      env.AMPLIFIER_PING_OWNERS,
      notionDatabaseId !== undefined && optional(env.NOTION_TOKEN) !== undefined,
    ),
    // Half an hour, because a note nobody has reposted within the first hour
    // has usually been scrolled past. The maximum is the timeout on
    // amplifier.remindRepost, which spends the delay as a sleep, so a larger
    // value would kill the run before it checks anything.
    reminderMinutes: whole("AMPLIFIER_REMINDER_MINUTES", env.AMPLIFIER_REMINDER_MINUTES, {
      fallback: 30,
      min: 0,
      max: MAX_REMINDER_MINUTES,
    }),
    reminderText: text(env.AMPLIFIER_REMINDER_TEXT, DEFAULT_REMINDER_TEXT),
  };
}

/**
 * Resolve one on/off setting from the environment, then the default.
 *
 * Unset or blank means the default, matching `whole` and `text`. Any value but
 * "true" or "false" throws, rather than reading as off: a variable set to "0"
 * or "no" was meant to turn the setting off, and silently doing the opposite
 * gives nobody an error to read.
 */
function flag(name: string, envValue: string | undefined, fallback: boolean): boolean {
  const value = envValue?.trim();
  if (value === undefined || value === "") return fallback;
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be "true" or "false"; got ${JSON.stringify(envValue)}.`);
  }
  return value === "true";
}

/**
 * Strip the leading "#" Slack uses to display a channel. `chat.postMessage`
 * takes a bare name or an id, so accept both forms and store the bare one.
 */
function channelName(value: string | undefined): string | undefined {
  return value?.trim().replace(/^#/, "") || undefined;
}

/**
 * Resolve one setting that has no default. A blank environment variable reads
 * as unset, matching `text`: a declared-but-empty variable is the normal state
 * of a Render env var nobody filled in.
 */
function optional(envValue: string | undefined): string | undefined {
  return envValue?.trim() || undefined;
}

/**
 * Resolve one string setting. A blank environment variable means "use the
 * default", matching `whole`: a declared-but-empty variable is the normal state
 * of a Render env var nobody filled in.
 */
function text(envValue: string | undefined, fallback: string, override?: string): string {
  return override?.trim() || envValue?.trim() || fallback;
}

/**
 * Resolve one whole-number setting from the per-run override, then the
 * environment, then the default.
 *
 * An unset or blank environment variable means "use the default", because a
 * declared-but-empty variable is the normal state of a Render env var nobody
 * filled in. Any other unusable value throws. A value that resolved to 0
 * instead would make every run pull no drafts and post nothing, with no error
 * to read.
 */
function whole(
  name: string,
  envValue: string | undefined,
  { fallback, min, max }: Bounds,
  override?: number,
): number {
  if (override === undefined && (envValue === undefined || envValue.trim() === "")) {
    return fallback;
  }
  const value = override ?? Number(envValue);
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    const range = max === undefined ? `of at least ${min}` : `between ${min} and ${max}`;
    throw new Error(
      `${name} must be a whole number ${range}; got ` +
        `${override !== undefined ? override : JSON.stringify(envValue)}.`,
    );
  }
  return value;
}
