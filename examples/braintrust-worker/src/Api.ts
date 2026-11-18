import * as Braintrust from "@alchemy.run/braintrust";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Classify, Support, Tickets } from "./resources.ts";

/**
 * `POST /tickets` triages a support question: it runs the `Classify`
 * function, logs the call to the project's logs, and adds the question to
 * the `Tickets` dataset with the chosen queue as its expected answer.
 */
export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const classify = yield* Braintrust.InvokeFunction(yield* Classify);
    const logs = yield* Braintrust.WriteProjectLogs(yield* Support);
    const tickets = yield* Braintrust.WriteDataset(yield* Tickets);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.method !== "POST" || new URL(request.url, "http://w").pathname !== "/tickets") {
          return HttpServerResponse.text('POST /tickets with {"question": "..."}');
        }
        const body = (yield* request.json) as { question?: unknown };
        if (typeof body?.question !== "string" || body.question === "") {
          return yield* HttpServerResponse.json({ error: "question is required" }, { status: 400 });
        }
        const question = body.question;

        const queue = yield* classify({ input: question });
        const logged = yield* logs.insert({
          events: [{ input: question, output: queue, metadata: { route: "/tickets" } }],
        });
        const logId = logged.row_ids[0];
        const added = yield* tickets.insert({
          events: [{ input: question, expected: queue, metadata: { logId } }],
        });

        return yield* HttpServerResponse.json({ queue, logId, recordId: added.row_ids[0] });
      }).pipe(
        Effect.catchTag("HttpServerError", () =>
          HttpServerResponse.json({ error: "body must be JSON" }, { status: 400 }),
        ),
        Effect.catch((error) =>
          HttpServerResponse.json({ error: String(error._tag ?? error) }, { status: 502 }),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Braintrust.InvokeFunctionHttp,
        Braintrust.WriteProjectLogsHttp,
        Braintrust.WriteDatasetHttp,
      ),
    ),
  ),
) {}
