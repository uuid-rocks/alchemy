import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { DATASET_READ, datasetClients, datasetId } from "./internal/DatasetHttp.ts";
import { ReadDataset, type ReadDatasetClient } from "./ReadDataset.ts";

/**
 * HTTP implementation of {@link ReadDataset}: Braintrust's REST API with the
 * host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const project = yield* Braintrust.Project("Support", {});
 *   const dataset = yield* Braintrust.Dataset("Tickets", { projectId: project.projectId });
 *   const records = yield* Braintrust.ReadDataset(dataset);
 *   // ...
 * }).pipe(Effect.provide(Braintrust.ReadDatasetHttp))
 * ```
 *
 * @layer
 * @product Dataset
 * @provides Braintrust.ReadDataset
 */
export const ReadDatasetHttp = Layer.succeed(
  ReadDataset,
  makeHttpBinding({
    id: datasetId,
    grants: [DATASET_READ],
    client: (auth, id): ReadDatasetClient => {
      const clients = datasetClients(auth, id);
      return {
        fetch: clients.fetch,
        summarize: clients.summarize,
        previewRestore: clients.previewRestore,
      };
    },
  }),
);
