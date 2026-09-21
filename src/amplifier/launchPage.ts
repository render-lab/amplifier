import type { TaskContext } from "@renderinc/sdk/workflows";
import type { AmplifierConfig } from "../config.js";
import { findLaunches } from "../notion/findLaunches.js";
import { readTypefullyUrl } from "../notion/launch.js";
import { findPost, type PostQuery } from "../typefully/match.js";
import type { PublishedPost } from "../typefully/types.js";
import * as log from "../log.js";

/** The last path segment of a URL, with any query string and fragment dropped. */
function lastSegment(url: string): string | undefined {
  const path = url
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "")
    .replace(/[?#].*$/, "")
    .split("/")
    .filter(Boolean);
  return path.pop();
}

/**
 * What to look for in a launch page's Typefully property, best first.
 *
 * The share URL is the link Typefully offers for sharing a draft, so it is the
 * one most likely to be on the page. The last segment of it is the draft's
 * public token, which still matches when somebody pasted the URL with tracking
 * parameters on the end or typed a different host for it. The draft id is last
 * because it also appears inside Typefully's own editor URLs.
 */
export function launchNeedles(post: PublishedPost): string[] {
  const needles: string[] = [];
  const shareUrl = post.shareUrl?.trim();
  if (shareUrl) {
    needles.push(shareUrl);
    const token = lastSegment(shareUrl);
    if (token) needles.push(token);
  }
  needles.push(post.draftId);
  return [...new Set(needles)];
}

/**
 * The launch page whose Typefully link matches a published post.
 *
 * Throws rather than returning a reason, because both callers are a human
 * naming one post and a silent no-op reads as a delivered DM.
 */
export async function resolveLaunchPageId(
  ctx: TaskContext,
  query: PostQuery,
  config: AmplifierConfig,
): Promise<string> {
  if (!config.notionDatabaseId) {
    throw new Error(
      "Set NOTION_DATABASE_ID to ping a page by post URL. Without the launch database there is " +
        "nothing to search; pass pageId instead.",
    );
  }

  const post = await findPost(ctx, query, config.socialSetId);

  const needles = launchNeedles(post);
  const { pages, truncated } = await ctx.run(findLaunches, {
    databaseId: config.notionDatabaseId,
    typefullyProperty: config.notionTypefullyProperty,
    needles,
  });
  if (pages.length === 0) {
    throw new Error(
      `No page in the launch database has ${post.shareUrl ?? `draft ${post.draftId}`} in its ` +
        `"${config.notionTypefullyProperty}" property. Somebody may not have pasted the ` +
        `Typefully link onto the page yet.`,
    );
  }

  // Ranked by which needle matched, so the share URL beats the draft id. An
  // exact share URL beats every contains match, because one draft's token can
  // be the start of another's.
  const ranked = pages
    .map((page) => {
      const url = readTypefullyUrl(page, config.notionTypefullyProperty) ?? "";
      if (url && url === needles[0]) return { page, rank: -1 };
      const matched = needles.findIndex((needle) => url.includes(needle));
      return { page, rank: matched === -1 ? needles.length : matched };
    })
    .sort((a, b) => a.rank - b.rank);

  const best = ranked[0]?.page;
  const pageId = best?.id?.trim();
  if (!pageId) {
    throw new Error("A page in the launch database matched but carried no id.");
  }
  if (pages.length > 1 || truncated) {
    log.info(
      `[amplifier] ${pages.length}${truncated ? "+" : ""} launch pages carry this Typefully ` +
        `link. Pinging ${pageId}; pass pageId to choose another.`,
    );
  }
  return pageId;
}
