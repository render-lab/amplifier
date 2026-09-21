import type { TaskContext } from "@renderinc/sdk/workflows";
import { MAX_LIMIT } from "../config.js";
import { listPublished } from "./listPublished.js";
import type { PublishedPost } from "./types.js";

/** The two ways a human names one published post. */
export interface PostQuery {
  /** Permalink to the live post, or its Typefully share URL. */
  url?: string;
  /** Typefully draft id, when the URL is not to hand. */
  draftId?: string;
}

/**
 * The draft a query names, by draft id when given and otherwise by URL.
 *
 * The URL is matched against both the platform permalinks and Typefully's own
 * share URL, because the link on a Notion launch page is the share URL — the
 * post is scheduled there before any permalink exists.
 */
function matchPost(posts: PublishedPost[], query: PostQuery): PublishedPost | undefined {
  if (query.draftId !== undefined) {
    return posts.find((p) => p.draftId === query.draftId);
  }
  return posts.find((p) => p.links.some((l) => l.url === query.url) || p.shareUrl === query.url);
}

/** Why nothing matched, for the throw that ends a manual run. */
function noMatchMessage(posts: PublishedPost[], query: PostQuery): string {
  const target = query.draftId !== undefined ? `draft ${query.draftId}` : `${query.url}`;
  return (
    `No published draft matches ${target} among the newest ${posts.length} Typefully ` +
    `returned. The post may be older than those, or its permalink may not be on X or ` +
    `LinkedIn.`
  );
}

/**
 * The published post a query names, or a throw saying why none matched.
 *
 * Pulls MAX_LIMIT drafts, because fifty is the widest Typefully allows and both
 * callers are a manual run naming one post rather than a scheduled scan.
 */
export async function findPost(
  ctx: TaskContext,
  query: PostQuery,
  socialSetId: string | undefined,
): Promise<PublishedPost> {
  const { posts } = await ctx.run(listPublished, {
    ...(socialSetId ? { socialSetId } : {}),
    limit: MAX_LIMIT,
  });
  const post = matchPost(posts, query);
  if (!post) throw new Error(noMatchMessage(posts, query));
  return post;
}
