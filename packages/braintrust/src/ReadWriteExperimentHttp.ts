import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import {
  EXPERIMENT_READ,
  EXPERIMENT_UPDATE,
  experimentClients,
  experimentId,
} from "./internal/ExperimentHttp.ts";
import { ReadWriteExperiment, type ReadWriteExperimentClient } from "./ReadWriteExperiment.ts";

/**
 * HTTP implementation of {@link ReadWriteExperiment}: Braintrust's REST API
 * with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const project = yield* Braintrust.Project("Support", {});
 *   const experiment = yield* Braintrust.Experiment("Baseline", { projectId: project.projectId });
 *   const results = yield* Braintrust.ReadWriteExperiment(experiment);
 *   // ...
 * }).pipe(Effect.provide(Braintrust.ReadWriteExperimentHttp))
 * ```
 *
 * @layer
 * @product Experiment
 * @provides Braintrust.ReadWriteExperiment
 */
export const ReadWriteExperimentHttp = Layer.succeed(
  ReadWriteExperiment,
  makeHttpBinding({
    id: experimentId,
    grants: [EXPERIMENT_READ, EXPERIMENT_UPDATE],
    client: (auth, id): ReadWriteExperimentClient => {
      const clients = experimentClients(auth, id);
      return {
        fetch: clients.fetch,
        summarize: clients.summarize,
        insert: clients.insert,
        feedback: clients.feedback,
      };
    },
  }),
);
