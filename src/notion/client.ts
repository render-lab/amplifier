import { createHttpClient, type FetchLike } from "@render-lab/tasks-core";
import { checkedBaseUrl } from "../http/baseUrl.js";
import type { NotionDataSource, NotionDatabase, NotionPage, QueryResult } from "./types.js";

/**
 * The slice of the Notion API amplifier needs. The impl depends on this port
 * so it can be unit-tested with a fake; the default is a REST client.
 */
export interface NotionPort {
  /** One page, with its property values. */
  getPage(pageId: string): Promise<NotionPage>;
  /** One database, read for the data sources under it. */
  getDatabase(databaseId: string): Promise<NotionDatabase>;
  /** One data source, read for its property schema. */
  getDataSource(dataSourceId: string): Promise<NotionDataSource>;
  /** Pages in a data source matching a filter. The body is Notion's query body. */
  queryDataSource(dataSourceId: string, body: unknown): Promise<QueryResult>;
}

export interface NotionDeps {
  notion: NotionPort;
}

/** Notion's real API. NOTION_BASE_URL overrides it for a local stub. */
export const NOTION_BASE_URL = "https://api.notion.com";

/**
 * The API version every call sends.
 *
 * Pinned in code and not in the environment. Notion changes response shapes
 * between versions, so an environment variable would let a deploy change what
 * `readLaunch` receives without a code change.
 */
export const NOTION_VERSION = "2025-09-03";

/**
 * Default Notion port. The token is read from NOTION_TOKEN on first call,
 * never at import, so a missing secret fails on use.
 *
 * The in-process retry absorbs a 429 burst: Notion rate-limits per
 * integration at about three requests a second, so a durable re-dispatch that
 * re-fires the same request would sustain the limit.
 */
export function notionPort(
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {},
): NotionPort {
  const env = opts.env ?? process.env;
  const client = createHttpClient({
    baseUrl: checkedBaseUrl(env.NOTION_BASE_URL, {
      name: "NOTION_BASE_URL",
      realBaseUrl: NOTION_BASE_URL,
      credential: "NOTION_TOKEN",
    }),
    label: "Notion API",
    // createHttpClient's fetchImpl is optional but not nullable, so omitting
    // the key selects global fetch. Spread it rather than pass undefined.
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    auth: () => {
      const token = env.NOTION_TOKEN;
      if (!token) {
        throw new Error(
          "NOTION_TOKEN is required for the notion tasks. Create an integration at " +
            "notion.so/profile/integrations, give it the user email capability, and grant it " +
            "the launch database. The Notion section of docs/deployment.md has the steps " +
            "for an internal and an OAuth integration.",
        );
      }
      return { authorization: `Bearer ${token}`, "notion-version": NOTION_VERSION };
    },
    retry: { maxRetries: 3, baseDelayMs: 1_000 },
  });

  return {
    async getPage(pageId) {
      const body = (await client.call(
        `/v1/pages/${encodeURIComponent(pageId)}`,
      )) as NotionPage | null;
      return body ?? {};
    },
    async getDatabase(databaseId) {
      const body = (await client.call(
        `/v1/databases/${encodeURIComponent(databaseId)}`,
      )) as NotionDatabase | null;
      return body ?? {};
    },
    async getDataSource(dataSourceId) {
      const body = (await client.call(
        `/v1/data_sources/${encodeURIComponent(dataSourceId)}`,
      )) as NotionDataSource | null;
      return body ?? {};
    },
    async queryDataSource(dataSourceId, query) {
      const body = (await client.call(
        `/v1/data_sources/${encodeURIComponent(dataSourceId)}/query`,
        {
          method: "POST",
          body: query,
        },
      )) as QueryResult | null;
      return body ?? {};
    },
  };
}

/**
 * Default deps used by the wrapped task in production.
 *
 * The port is built on first use, not at import, so NOTION_TOKEN and
 * NOTION_BASE_URL are read from the environment the run actually has.
 */
let port: NotionPort | undefined;
export const defaultDeps: NotionDeps = {
  get notion(): NotionPort {
    return (port ??= notionPort());
  },
};
