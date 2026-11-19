import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { InsertExperimentEvents } from "./InsertExperimentEvents.ts";
import { EXPERIMENT_UPDATE, experimentClients, experimentId } from "./internal/ExperimentHttp.ts";

/**
 * HTTP implementation of {@link InsertExperimentEvents}: Braintrust's REST
 * API with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const project = yield* Braintrust.Project("Support", {});
 *   const experiment = yield* Braintrust.Experiment("Baseline", { projectId: project.projectId });
 *   const insert = yield* Braintrust.InsertExperimentEvents(experiment);
 *   // ...
 * }).pipe(Effect.provide(Braintrust.InsertExperimentEventsHttp))
 * ```
 *
 * @layer
 * @product Experiment
 * @provides Braintrust.InsertExperimentEvents
 */
export const InsertExperimentEventsHttp = Layer.succeed(
  InsertExperimentEvents,
  makeHttpBinding({
    id: experimentId,
    grants: [EXPERIMENT_UPDATE],
    client: (auth, id) => experimentClients(auth, id).insert,
  }),
);
