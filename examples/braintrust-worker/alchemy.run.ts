import * as Braintrust from "@alchemy.run/braintrust";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";
import { Support, Tickets } from "./src/resources.ts";

export default Alchemy.Stack(
  "BraintrustWorkerExample",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Braintrust.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const project = yield* Support;
    const tickets = yield* Tickets;
    const api = yield* Api;

    return {
      url: api.url.as<string>(),
      projectId: project.projectId,
      datasetId: tickets.datasetId,
    };
  }),
);
