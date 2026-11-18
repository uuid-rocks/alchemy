import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { EXPERIMENT_READ, experimentClients, experimentId } from "./internal/ExperimentHttp.ts";
import { ReadExperiment, type ReadExperimentClient } from "./ReadExperiment.ts";

/**
 * HTTP implementation of {@link ReadExperiment}: Braintrust's REST API with
 * the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const experiment = yield* Braintrust.Experiment("Baseline", { projectId: project.projectId });
 * const results = yield* Braintrust.ReadExperiment(experiment).pipe(
 *   Effect.provide(Braintrust.ReadExperimentHttp),
 * );
 * ```
 *
 * @layer
 * @product Experiment
 * @provides Braintrust.ReadExperiment
 */
export const ReadExperimentHttp = Layer.succeed(
  ReadExperiment,
  makeHttpBinding({
    id: experimentId,
    grants: [EXPERIMENT_READ],
    client: (auth, id): ReadExperimentClient => {
      const clients = experimentClients(auth, id);
      return {
        fetch: clients.fetch,
        summarize: clients.summarize,
      };
    },
  }),
);
