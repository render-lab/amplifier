import { renderDispatcher } from "@render-lab/triggers";
import * as log from "../log.js";

/** Starts a workflow run by task name. */
export type StartRun = (task: string, args: unknown[]) => Promise<void>;

/**
 * Start a workflow run by task name, or report that this deploy cannot.
 *
 * A task that has to outlive the run that wants it — the repost reminder, whose
 * delay is a 30-minute sleep — runs as its own run, so cancelling or
 * redeploying the announce path does not take it along.
 *
 * The dispatcher is built per call, so RENDER_API_KEY and WORKFLOW_SLUG are
 * read from the environment the run has rather than the one the module loaded
 * in. This is a call from the Workflow service back to itself by slug, the same
 * Render API call the receiver makes.
 */
export async function startRun(
  task: string,
  args: unknown[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const slug = env.WORKFLOW_SLUG?.trim();
  const apiKey = env.RENDER_API_KEY?.trim();
  // Logged and skipped rather than thrown, so `pnpm local:run` and `localCtx`
  // stay off the Render API. The `Render` client throws "API token is required"
  // when the key is unset, which is why the key is checked before it is built.
  if (!slug || !apiKey) {
    log.info(
      `[amplifier] Not starting ${task}: this service has no ` +
        `${!slug ? "WORKFLOW_SLUG" : "RENDER_API_KEY"}.`,
    );
    return;
  }
  // The run id is the only handle on a run nobody awaits, so it is logged for
  // whoever has to find the reminder's run in the dashboard.
  const { runId } = await renderDispatcher({ slug }).start(task, args);
  log.info(`[amplifier] Started ${task} as run ${runId}.`);
}
