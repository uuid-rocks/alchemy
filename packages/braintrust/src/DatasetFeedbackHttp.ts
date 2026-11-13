import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { DatasetFeedback } from "./DatasetFeedback.ts";
import { DATASET_UPDATE, datasetClients, datasetId } from "./DatasetHttp.ts";

/**
 * HTTP implementation of {@link DatasetFeedback}: Braintrust's REST API with
 * the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const feedback = yield* Braintrust.DatasetFeedback(dataset);
 *   // ...
 * }).pipe(Effect.provide(Braintrust.DatasetFeedbackHttp))
 * ```
 *
 * @layer
 * @product Dataset
 * @provides Braintrust.DatasetFeedback
 */
export const DatasetFeedbackHttp = Layer.succeed(
  DatasetFeedback,
  makeHttpBinding({
    id: datasetId,
    grants: [DATASET_UPDATE],
    client: (auth, id) => datasetClients(auth, id).feedback,
  }),
);
