import { describe, expect, it, vi } from "vitest";
import { fakeCtx } from "@render-lab/test-utils";
import { NOTION_VERSION, notionPort } from "../src/notion/client.js";
import { getPageImpl } from "../src/notion/getPage.js";
import { fakeNotion, NOTION_PAGE as PAGE } from "./support/notionPort.js";

/** A fetch that records the call and answers with the fixture page. */
function fakeFetch() {
  return vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(PAGE),
    json: async () => PAGE,
    url,
    init,
  }));
}

describe("notionPort", () => {
  it("sends the bearer token and the pinned API version", async () => {
    const fetchImpl = fakeFetch();
    const port = notionPort({ env: { NOTION_TOKEN: "ntn_test" }, fetchImpl });

    await port.getPage(PAGE.id as string);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`https://api.notion.com/v1/pages/${PAGE.id}`);
    expect(init?.headers?.["authorization"]).toBe("Bearer ntn_test");
    expect(init?.headers?.["notion-version"]).toBe(NOTION_VERSION);
  });

  it("fails on use, not at import, when the token is unset", async () => {
    const port = notionPort({ env: {}, fetchImpl: fakeFetch() });
    await expect(port.getPage("page_1")).rejects.toThrow(/NOTION_TOKEN is required/);
  });

  it("refuses a base URL that would send the token to another host", () => {
    expect(() =>
      notionPort({ env: { NOTION_TOKEN: "ntn_test", NOTION_BASE_URL: "https://evil.example" } }),
    ).toThrow(/NOTION_TOKEN would be sent to evil.example/);
  });

  it("accepts a loopback base URL for the local stub", () => {
    expect(() =>
      notionPort({ env: { NOTION_TOKEN: "ntn_test", NOTION_BASE_URL: "http://localhost:8787" } }),
    ).not.toThrow();
  });
});

describe("getPageImpl", () => {
  it("hands the page back as it came", async () => {
    const getPage = vi.fn(async () => PAGE);
    const deps = { notion: fakeNotion({ getPage }) };

    const { page } = await getPageImpl(fakeCtx(), { pageId: "page_1" }, deps);

    expect(getPage).toHaveBeenCalledWith("page_1");
    expect(page.id).toBe(PAGE.id);
  });

  it("refuses an empty page id", async () => {
    const deps = { notion: fakeNotion({ getPage: vi.fn(async () => PAGE) }) };
    await expect(getPageImpl(fakeCtx(), { pageId: "" }, deps)).rejects.toThrow(/pageId/);
  });
});
