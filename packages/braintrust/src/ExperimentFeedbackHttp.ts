import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { ExperimentFeedback } from "./ExperimentFeedback.ts";
import { EXPERIMENT_UPDATE, experimentClients, experimentId } from "./internal/ExperimentHttp.ts";

/**
 * HTTP implementation of {@link ExperimentFeedback}: Braintrust's REST API
 * with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const project = yield* Braintrust.Project("Support", {});
 *   const experiment = yield* Braintrust.Experiment("Baseline", { projectId: project.projectId });
 *   const feedback = yield* Braintrust.ExperimentFeedback(experiment);
 *   // ...
 * }).pipe(Effect.provide(Braintrust.ExperimentFeedbackHttp))
 * ```
 *
 * @layer
 * @product Experiment
 * @provides Braintrust.ExperimentFeedback
 */
export const ExperimentFeedbackHttp = Layer.succeed(
  ExperimentFeedback,
  makeHttpBinding({
    id: experimentId,
    grants: [EXPERIMENT_UPDATE],
    client: (auth, id) => experimentClients(auth, id).feedback,
  }),
);
