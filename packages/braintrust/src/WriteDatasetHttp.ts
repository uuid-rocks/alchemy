import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { DATASET_UPDATE, datasetClients, datasetId } from "./internal/DatasetHttp.ts";
import { WriteDataset, type WriteDatasetClient } from "./WriteDataset.ts";

/**
 * HTTP implementation of {@link WriteDataset}: Braintrust's REST API with
 * the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const dataset = yield* Braintrust.Dataset("Tickets", { projectId: project.projectId });
 * const records = yield* Braintrust.WriteDataset(dataset).pipe(
 *   Effect.provide(Braintrust.WriteDatasetHttp),
 * );
 * ```
 *
 * @layer
 * @product Dataset
 * @provides Braintrust.WriteDataset
 */
export const WriteDatasetHttp = Layer.succeed(
  WriteDataset,
  makeHttpBinding({
    id: datasetId,
    grants: [DATASET_UPDATE],
    client: (auth, id): WriteDatasetClient => {
      const clients = datasetClients(auth, id);
      return {
        insert: clients.insert,
        feedback: clients.feedback,
      };
    },
  }),
);
