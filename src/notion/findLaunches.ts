import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { defaultDeps, type NotionDeps } from "./client.js";
import { matchPropertyName } from "./launch.js";
import { NOTION_RETRY } from "./retry.js";
import type { FindLaunchesInput, FindLaunchesResult } from "./types.js";
import * as log from "../log.js";

/**
 * Property types a contains filter works on. The filter key in Notion's query
 * body is the type's own name, so this doubles as the set of usable keys.
 */
const FILTERABLE = ["url", "rich_text", "title"];

/** Widest result set worth looking at. A URL matches one launch page, not ten. */
const PAGE_SIZE = 10;

/** Shortest needle accepted, so a one-character id cannot match every page. */
const MIN_NEEDLE = 4;

/** Raw implementation of notion.findLaunches. */
export async function findLaunchesImpl(
  _ctx: TaskContext,
  input: FindLaunchesInput,
  deps: NotionDeps = defaultDeps,
): Promise<FindLaunchesResult> {
  const databaseId = input.databaseId?.trim();
  if (!databaseId) {
    throw new Error(
      "Pass the launch database as databaseId. Set NOTION_DATABASE_ID to search by post URL.",
    );
  }

  const needles = [
    ...new Set((input.needles ?? []).map((n) => n.trim()).filter((n) => n.length >= MIN_NEEDLE)),
  ];
  if (needles.length === 0) {
    throw new Error(`Pass at least one needle of ${MIN_NEEDLE} characters or more.`);
  }

  // A database holds its pages in one or more data sources since Notion
  // 2025-09-03, and only a data source can be queried.
  const database = await deps.notion.getDatabase(databaseId);
  const sources = database.data_sources ?? [];
  const dataSourceId = sources[0]?.id;
  if (!dataSourceId) {
    throw new Error(
      `Notion database ${databaseId} reports no data sources. Check that NOTION_DATABASE_ID is ` +
        `a database id and that the integration is connected to it.`,
    );
  }
  if (sources.length > 1) {
    log.info(
      `[amplifier] Database ${databaseId} has ${sources.length} data sources. Searching the ` +
        `first, ${sources[0]?.name ?? dataSourceId}.`,
    );
  }

  // The filter names the property by its exact display name, so the loose
  // match runs against the schema rather than against a page.
  const schema = await deps.notion.getDataSource(dataSourceId);
  const properties = schema.properties ?? {};
  const name = matchPropertyName(properties, input.typefullyProperty, FILTERABLE);
  if (!name) {
    throw new Error(
      `No property named like "${input.typefullyProperty}" in the launch database. It has: ` +
        `${Object.keys(properties).join(", ") || "no properties"}.`,
    );
  }

  const type = properties[name]?.type;
  if (!type || !FILTERABLE.includes(type)) {
    throw new Error(
      `The launch database's "${name}" property is a ${type ?? "unknown"} property, which ` +
        `Notion cannot filter by text. Point NOTION_TYPEFULLY_PROPERTY at a url or text property.`,
    );
  }

  const result = await deps.notion.queryDataSource(dataSourceId, {
    filter: { or: needles.map((needle) => ({ property: name, [type]: { contains: needle } })) },
    page_size: PAGE_SIZE,
  });

  return { pages: result.results ?? [], truncated: result.has_more === true };
}

/**
 * Launch pages whose Typefully property contains one of the needles.
 *
 * This is how a live post's permalink reaches its owners: Typefully turns the
 * permalink into the draft's share URL, and the share URL is what somebody
 * pasted onto the launch page.
 */
export const findLaunches = task(
  { name: "notion.findLaunches", retry: NOTION_RETRY },
  findLaunchesImpl,
);
