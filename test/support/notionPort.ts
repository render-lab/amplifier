import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { NotionPort } from "../../src/notion/client.js";
import type { NotionPage } from "../../src/notion/types.js";

/**
 * A Notion port whose every method is a mock, so a test names only the calls
 * it cares about. The unnamed ones throw, which is how a test hears about a
 * call it did not expect.
 */
export function fakeNotion(overrides: Partial<NotionPort> = {}): NotionPort {
  const unexpected = <M extends keyof NotionPort>(method: M): NotionPort[M] =>
    vi.fn(async () => {
      throw new Error(`Unexpected Notion call: ${method}`);
    });
  return {
    getPage: unexpected("getPage"),
    getDatabase: unexpected("getDatabase"),
    getDataSource: unexpected("getDataSource"),
    queryDataSource: unexpected("queryDataSource"),
    ...overrides,
  };
}

/** A page carrying one Typefully URL, for the search tests. */
export function launchPage(id: string, url: string, property = "Typefully"): NotionPage {
  return { id, properties: { [property]: { type: "url", url } } };
}

/**
 * A real launch page response, shaped from Notion's documented page object.
 *
 * Read once and shared, so a test that wants a variant spreads it rather than
 * editing it in place.
 */
export const NOTION_PAGE: NotionPage = JSON.parse(
  readFileSync(new URL("./notion-page.json", import.meta.url), "utf8"),
);
