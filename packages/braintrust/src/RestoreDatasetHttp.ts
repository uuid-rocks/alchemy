import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { DATASET_UPDATE, datasetClients, datasetId } from "./DatasetHttp.ts";
import { RestoreDataset } from "./RestoreDataset.ts";

/**
 * HTTP implementation of {@link RestoreDataset}: Braintrust's REST API with
 * the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const restore = yield* Braintrust.RestoreDataset(dataset);
 *   // ...
 * }).pipe(Effect.provide(Braintrust.RestoreDatasetHttp))
 * ```
 *
 * @layer
 * @product Dataset
 * @provides Braintrust.RestoreDataset
 */
export const RestoreDatasetHttp = Layer.succeed(
  RestoreDataset,
  makeHttpBinding({
    id: datasetId,
    grants: [DATASET_UPDATE],
    client: (auth, id) => datasetClients(auth, id).restore,
  }),
);
