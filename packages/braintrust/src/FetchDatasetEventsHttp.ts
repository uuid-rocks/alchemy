import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { DATASET_READ, datasetClients, datasetId } from "./DatasetHttp.ts";
import { FetchDatasetEvents } from "./FetchDatasetEvents.ts";

/**
 * HTTP implementation of {@link FetchDatasetEvents}: Braintrust's REST API
 * with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const fetch = yield* Braintrust.FetchDatasetEvents(dataset);
 *   // ...
 * }).pipe(Effect.provide(Braintrust.FetchDatasetEventsHttp))
 * ```
 *
 * @layer
 * @product Dataset
 * @provides Braintrust.FetchDatasetEvents
 */
export const FetchDatasetEventsHttp = Layer.succeed(
  FetchDatasetEvents,
  makeHttpBinding({
    id: datasetId,
    grants: [DATASET_READ],
    client: (auth, id) => datasetClients(auth, id).fetch,
  }),
);
