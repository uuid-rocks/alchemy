import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { DATASET_READ, datasetClients, datasetId } from "./internal/DatasetHttp.ts";
import { SummarizeDataset } from "./SummarizeDataset.ts";

/**
 * HTTP implementation of {@link SummarizeDataset}: Braintrust's REST API
 * with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const dataset = yield* Braintrust.Dataset("Tickets", { projectId: project.projectId });
 * const summarize = yield* Braintrust.SummarizeDataset(dataset).pipe(
 *   Effect.provide(Braintrust.SummarizeDatasetHttp),
 * );
 * ```
 *
 * @layer
 * @product Dataset
 * @provides Braintrust.SummarizeDataset
 */
export const SummarizeDatasetHttp = Layer.succeed(
  SummarizeDataset,
  makeHttpBinding({
    id: datasetId,
    grants: [DATASET_READ],
    client: (auth, id) => datasetClients(auth, id).summarize,
  }),
);
