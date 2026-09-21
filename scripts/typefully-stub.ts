/**
 * A stand-in for Typefully and the Slack Web API, so the whole announce-once
 * path can run locally with no credentials.
 *
 *   pnpm stub
 *
 * It serves two routes:
 *
 *   GET  /v2/social-sets/:id/drafts   the canned drafts below, honouring `limit`
 *   POST /slack/chat.postMessage      logs the message and returns a ts
 *
 * Point the app at it with TYPEFULLY_BASE_URL and SLACK_API_BASE_URL. See
 * scripts/local-run.ts for the full command.
 *
 * The drafts are newest-first, which is what the real API is assumed to do.
 * Reverse DRAFTS to reproduce the oldest-first case where `limit` truncates the
 * window to nothing and every run posts nothing without erroring.
 */
import { createServer } from "node:http";
import type { TypefullyDraft } from "../src/typefully/types.js";

const PORT = Number(process.env.STUB_PORT ?? 8787);

/** Minutes before now, so the drafts always land inside the lookback window. */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/**
 * Draft 101 is a cross-post: one note covering X and LinkedIn four minutes
 * apart. Draft 102 is X only, far enough back to be its own note.
 *
 * Neither draft sets `x_post_published_at`, because the real API never does.
 * X carries only `x_published_url`, and its link time comes from `published_at`.
 */
const DRAFTS: TypefullyDraft[] = [
  {
    id: 101,
    preview: "We shipped instant Postgres restores.",
    status: "published",
    published_at: minutesAgo(20),
    share_url: "https://typefully.com/t/101",
    x_post_enabled: true,
    x_post_published_at: null,
    x_published_url: "https://x.com/render/status/101",
    linkedin_post_enabled: true,
    linkedin_post_published_at: minutesAgo(16),
    linkedin_published_url: "https://linkedin.com/feed/update/101",
  },
  {
    id: 102,
    preview: "Workflows now retry a failed task without replaying the run.",
    status: "published",
    published_at: minutesAgo(55),
    share_url: "https://typefully.com/t/102",
    x_post_enabled: true,
    x_post_published_at: null,
    x_published_url: "https://x.com/render/status/102",
  },
];

/** A distinct, increasing message timestamp, the way Slack hands them out. */
let posted = 0;
function nextTs(): string {
  posted += 1;
  return `1758000000.${String(posted).padStart(6, "0")}`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && /^\/v2\/social-sets\/[^/]+\/drafts$/.test(url.pathname)) {
    const limit = Number(url.searchParams.get("limit") ?? DRAFTS.length);
    const results = DRAFTS.slice(0, limit);
    console.log(
      `[stub] ${url.pathname}?${url.searchParams.toString()} -> ${results.length} drafts`,
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ results }));
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/slack/")) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const sent = JSON.parse(body || "{}") as {
        text?: string;
        thread_ts?: string;
        blocks?: { text?: { text?: string } }[];
      };
      const shown = sent.blocks?.[0]?.text?.text ?? sent.text;
      console.log(`[stub] slack <- ${sent.thread_ts ? "reply " : ""}${shown}`);
      // A ts, because announceGroups threads the replies under the parent's.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, channel: "C_LOCAL", ts: nextTs() }));
    });
    return;
  }

  console.log(`[stub] 404 ${req.method} ${url.pathname}`);
  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`[stub] Typefully and the Slack Web API on http://localhost:${PORT}`);
});
