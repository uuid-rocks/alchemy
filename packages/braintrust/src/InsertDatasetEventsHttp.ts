import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { DATASET_UPDATE, datasetClients, datasetId } from "./DatasetHttp.ts";
import { InsertDatasetEvents } from "./InsertDatasetEvents.ts";

/**
 * HTTP implementation of {@link InsertDatasetEvents}: Braintrust's REST API
 * with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const dataset = yield* Braintrust.Dataset("Tickets", { projectId: project.projectId });
 * const insert = yield* Braintrust.InsertDatasetEvents(dataset).pipe(
 *   Effect.provide(Braintrust.InsertDatasetEventsHttp),
 * );
 * ```
 *
 * @layer
 * @product Dataset
 * @provides Braintrust.InsertDatasetEvents
 */
export const InsertDatasetEventsHttp = Layer.succeed(
  InsertDatasetEvents,
  makeHttpBinding({
    id: datasetId,
    grants: [DATASET_UPDATE],
    client: (auth, id) => datasetClients(auth, id).insert,
  }),
);
