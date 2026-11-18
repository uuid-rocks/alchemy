import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { FetchExperimentEvents } from "./FetchExperimentEvents.ts";
import { EXPERIMENT_READ, experimentClients, experimentId } from "./internal/ExperimentHttp.ts";

/**
 * HTTP implementation of {@link FetchExperimentEvents}: Braintrust's REST
 * API with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const experiment = yield* Braintrust.Experiment("Baseline", { projectId: project.projectId });
 * const fetch = yield* Braintrust.FetchExperimentEvents(experiment).pipe(
 *   Effect.provide(Braintrust.FetchExperimentEventsHttp),
 * );
 * ```
 *
 * @layer
 * @product Experiment
 * @provides Braintrust.FetchExperimentEvents
 */
export const FetchExperimentEventsHttp = Layer.succeed(
  FetchExperimentEvents,
  makeHttpBinding({
    id: experimentId,
    grants: [EXPERIMENT_READ],
    client: (auth, id) => experimentClients(auth, id).fetch,
  }),
);
