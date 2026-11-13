import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { DATASET_READ, datasetClients, datasetId } from "./DatasetHttp.ts";
import { PreviewDatasetRestore } from "./PreviewDatasetRestore.ts";

/**
 * HTTP implementation of {@link PreviewDatasetRestore}: Braintrust's REST
 * API with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const previewRestore = yield* Braintrust.PreviewDatasetRestore(dataset);
 *   // ...
 * }).pipe(Effect.provide(Braintrust.PreviewDatasetRestoreHttp))
 * ```
 *
 * @layer
 * @product Dataset
 * @provides Braintrust.PreviewDatasetRestore
 */
export const PreviewDatasetRestoreHttp = Layer.succeed(
  PreviewDatasetRestore,
  makeHttpBinding({
    id: datasetId,
    grants: [DATASET_READ],
    client: (auth, id) => datasetClients(auth, id).previewRestore,
  }),
);
