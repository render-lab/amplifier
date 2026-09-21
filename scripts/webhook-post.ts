/**
 * Sign the captured Typefully event and POST it to a locally running receiver.
 *
 *   pnpm build
 *   PORT=3000 WORKFLOW_SLUG=<slug> RENDER_API_KEY=<key> \
 *     TYPEFULLY_WEBHOOK_SECRET=whsec_local pnpm trigger:serve &
 *   TYPEFULLY_WEBHOOK_SECRET=whsec_local pnpm webhook:post 101
 *
 * The argument is the draft id to put in the payload, so the event can be
 * pointed at whatever `scripts/typefully-stub.ts` serves. It defaults to the
 * id in the captured event.
 *
 * A 202 proves the signature and the mapping. The run itself is the Workflow
 * service's business, and the receiver never waits for it. A 401 means the
 * secret here and the secret the receiver read do not match.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const RECEIVER = process.env.WEBHOOK_URL ?? "http://localhost:3000/webhooks/typefully";
const secret = process.env.TYPEFULLY_WEBHOOK_SECRET;
if (!secret) {
  throw new Error("Set TYPEFULLY_WEBHOOK_SECRET to the same value the receiver reads.");
}

/** The fields this script rewrites before signing. The rest is passed through. */
interface TypefullyEvent {
  event: string;
  data: { id: number };
}

const event = JSON.parse(
  readFileSync(new URL("../test/support/typefully-event.json", import.meta.url), "utf8"),
) as TypefullyEvent;
const draftId = process.argv[2];
if (draftId !== undefined) {
  // A non-numeric argument would serialize as null and send an event with no
  // draft id, which looks like a rescan rather than a mistake.
  if (!/^\d+$/.test(draftId)) {
    throw new Error(`The draft id has to be a whole number; got ${JSON.stringify(draftId)}.`);
  }
  event.data.id = Number(draftId);
}

// Sign exactly the bytes that go on the wire. Typefully signs the timestamp, a
// literal ".", and the raw body.
const rawBody = JSON.stringify(event);
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

const response = await fetch(RECEIVER, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-typefully-event": event.event,
    "x-typefully-timestamp": timestamp,
    "x-typefully-signature": `sha256=${signature}`,
  },
  body: rawBody,
});

console.log(`${response.status} ${await response.text()}`);
