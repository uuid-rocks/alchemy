import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { EXPERIMENT_READ, experimentClients, experimentId } from "./ExperimentHttp.ts";
import { SummarizeExperiment } from "./SummarizeExperiment.ts";

/**
 * HTTP implementation of {@link SummarizeExperiment}: Braintrust's REST API
 * with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const experiment = yield* Braintrust.Experiment("Baseline", { projectId: project.projectId });
 * const summarize = yield* Braintrust.SummarizeExperiment(experiment).pipe(
 *   Effect.provide(Braintrust.SummarizeExperimentHttp),
 * );
 * ```
 *
 * @layer
 * @product Experiment
 * @provides Braintrust.SummarizeExperiment
 */
export const SummarizeExperimentHttp = Layer.succeed(
  SummarizeExperiment,
  makeHttpBinding({
    id: experimentId,
    grants: [EXPERIMENT_READ],
    client: (auth, id) => experimentClients(auth, id).summarize,
  }),
);
