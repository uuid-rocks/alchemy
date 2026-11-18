import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { EXPERIMENT_UPDATE, experimentClients, experimentId } from "./internal/ExperimentHttp.ts";
import { WriteExperiment, type WriteExperimentClient } from "./WriteExperiment.ts";

/**
 * HTTP implementation of {@link WriteExperiment}: Braintrust's REST API with
 * the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const experiment = yield* Braintrust.Experiment("Baseline", { projectId: project.projectId });
 * const results = yield* Braintrust.WriteExperiment(experiment).pipe(
 *   Effect.provide(Braintrust.WriteExperimentHttp),
 * );
 * ```
 *
 * @layer
 * @product Experiment
 * @provides Braintrust.WriteExperiment
 */
export const WriteExperimentHttp = Layer.succeed(
  WriteExperiment,
  makeHttpBinding({
    id: experimentId,
    grants: [EXPERIMENT_UPDATE],
    client: (auth, id): WriteExperimentClient => {
      const clients = experimentClients(auth, id);
      return {
        insert: clients.insert,
        feedback: clients.feedback,
      };
    },
  }),
);
