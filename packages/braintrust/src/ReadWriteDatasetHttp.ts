import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { DATASET_READ, DATASET_UPDATE, datasetClients, datasetId } from "./DatasetHttp.ts";
import { ReadWriteDataset, type ReadWriteDatasetClient } from "./ReadWriteDataset.ts";

/**
 * HTTP implementation of {@link ReadWriteDataset}: Braintrust's REST API
 * with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const records = yield* Braintrust.ReadWriteDataset(dataset);
 *   // ...
 * }).pipe(Effect.provide(Braintrust.ReadWriteDatasetHttp))
 * ```
 *
 * @layer
 * @product Dataset
 * @provides Braintrust.ReadWriteDataset
 */
export const ReadWriteDatasetHttp = Layer.succeed(
  ReadWriteDataset,
  makeHttpBinding({
    id: datasetId,
    grants: [DATASET_READ, DATASET_UPDATE],
    client: (auth, id): ReadWriteDatasetClient => {
      const clients = datasetClients(auth, id);
      return {
        fetch: clients.fetch,
        summarize: clients.summarize,
        previewRestore: clients.previewRestore,
        insert: clients.insert,
        feedback: clients.feedback,
        restore: clients.restore,
      };
    },
  }),
);
