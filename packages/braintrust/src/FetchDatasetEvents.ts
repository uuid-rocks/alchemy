import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Dataset } from "./Dataset.ts";

/** Braintrust's `fetchDatasetEvents` request, without `dataset_id`. */
export interface FetchDatasetEventsRequest extends Omit<
  braintrust.FetchDatasetEventsRequest,
  "dataset_id"
> {}

/** Read the records of a Braintrust dataset, a page at a time. */
export type FetchDatasetEventsClient = (
  request?: FetchDatasetEventsRequest,
) => Effect.Effect<
  braintrust.FetchDatasetEventsResponse,
  braintrust.FetchDatasetEventsError,
  RuntimeContext
>;

/**
 * Read the records of a Braintrust dataset, a page at a time. Calls take no
 * `dataset_id`: the dataset is fixed by `FetchDatasetEvents(dataset)`.
 *
 * The host gets its own Braintrust service account and token, with `read` on
 * `dataset` for this dataset only. Braintrust has no workload identity, so
 * the token is created at deploy and bound into the host as a secret;
 * destroying the host revokes it.
 *
 * ### Reading records
 * **Example:** FetchDatasetEvents from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const project = yield* Braintrust.Project("Support", {});
 *     const dataset = yield* Braintrust.Dataset("Tickets", { projectId: project.projectId });
 *     const fetch = yield* Braintrust.FetchDatasetEvents(dataset);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { events } = yield* fetch({ limit: 100 });
 *         return yield* HttpServerResponse.json(events);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.FetchDatasetEventsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Dataset
 */
export interface FetchDatasetEvents extends Binding.Service<
  FetchDatasetEvents,
  "Braintrust.FetchDatasetEvents",
  (dataset: Dataset) => Effect.Effect<FetchDatasetEventsClient>
> {}

export const FetchDatasetEvents = Binding.Service<FetchDatasetEvents>(
  "Braintrust.FetchDatasetEvents",
);
