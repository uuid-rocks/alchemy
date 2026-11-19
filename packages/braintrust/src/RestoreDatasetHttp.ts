import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import {
  DATASET_DELETE,
  DATASET_UPDATE,
  datasetClients,
  datasetId,
} from "./internal/DatasetHttp.ts";
import { RestoreDataset } from "./RestoreDataset.ts";

/**
 * HTTP implementation of {@link RestoreDataset}: Braintrust's REST API with
 * the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const project = yield* Braintrust.Project("Support", {});
 *   const dataset = yield* Braintrust.Dataset("Tickets", { projectId: project.projectId });
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
    // A restore deletes the records added since the version, which Braintrust
    // checks as `delete` on the dataset.
    grants: [DATASET_UPDATE, DATASET_DELETE],
    client: (auth, id) => datasetClients(auth, id).restore,
  }),
);
