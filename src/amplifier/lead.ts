import type { PostMessageInput } from "@render-lab/tasks-slack";
import { section, sectionMrkdwn, THREAD_MARKER, THREAD_MARKER_PATTERN } from "./template.js";

/** The failed-summary line `renderParent` adds, which a person's own lead replaces. */
const FAILURE_LINE = /^_\(Summarization LLM call failed:.*\)_$/;

/** Index of the first section block, or -1. */
function sectionIndex(message: PostMessageInput): number {
  return (message.blocks ?? []).findIndex((block) => block["type"] === "section");
}

/** The first section block's mrkdwn, given the index `sectionIndex` reported. */
function sectionText(message: PostMessageInput, index: number): string | undefined {
  return sectionMrkdwn((message.blocks ?? [])[index]);
}

/**
 * A note's lead line without the 🧵, which is what the modal prefills.
 *
 * It comes from the rendered message, because nothing stores the group.
 */
export function leadOf(message: PostMessageInput): string | undefined {
  const index = sectionIndex(message);
  if (index === -1) return undefined;
  const text = sectionText(message, index);
  if (text === undefined) return undefined;
  const first = text.split("\n")[0] ?? "";
  const lead = first.replace(THREAD_MARKER_PATTERN, "");
  return lead === "" ? undefined : lead;
}

/**
 * The same note with a new lead line, or null when it has no section block.
 *
 * Only the first line of the first section block changes. The links, the quoted
 * preview, the dropped-platform line and the buttons record what the run posted,
 * so an edit leaves them alone. `text` is the notification fallback, which
 * carries no marker.
 */
export function withLead(message: PostMessageInput, lead: string): PostMessageInput | null {
  const index = sectionIndex(message);
  const text = sectionText(message, index);
  if (index === -1 || text === undefined) return null;

  const lines = text.split("\n");
  const marker = THREAD_MARKER_PATTERN.test(lines[0] ?? "") ? THREAD_MARKER : "";
  const rest = lines.slice(1).filter((line) => !FAILURE_LINE.test(line));

  // The submitted lead can still end in a marker, from a modal opened before
  // `leadOf` stripped the shortcode form. Strip it rather than write it twice.
  const written = lead.replace(THREAD_MARKER_PATTERN, "");

  const blocks = [...(message.blocks ?? [])];
  blocks[index] = section([`${written}${marker}`, ...rest].join("\n"));
  return { ...message, text: written, blocks };
}
