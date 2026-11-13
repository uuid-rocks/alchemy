import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Dataset } from "./Dataset.ts";

/** Braintrust's `insertDatasetEvents` request, without `dataset_id`. */
export interface InsertDatasetEventsRequest extends Omit<
  braintrust.InsertDatasetEventsRequest,
  "dataset_id"
> {}

/** Add or update records in a Braintrust dataset. */
export type InsertDatasetEventsClient = (
  request: InsertDatasetEventsRequest,
) => Effect.Effect<
  braintrust.InsertEventsResponse,
  braintrust.InsertDatasetEventsError,
  RuntimeContext
>;

/**
 * Add or update records in a Braintrust dataset. Calls take no `dataset_id`:
 * the dataset is fixed by `InsertDatasetEvents(dataset)`.
 *
 * The host gets its own Braintrust service account and token, with `update`
 * on `dataset` for this dataset only. Braintrust has no workload identity,
 * so the token is created at deploy and bound into the host as a secret;
 * destroying the host revokes it.
 *
 * ### Adding records
 * **Example:** InsertDatasetEvents from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const insert = yield* Braintrust.InsertDatasetEvents(dataset);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* insert({ events: [{ input: { question }, expected: answer }] });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.InsertDatasetEventsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Dataset
 */
export interface InsertDatasetEvents extends Binding.Service<
  InsertDatasetEvents,
  "Braintrust.InsertDatasetEvents",
  (dataset: Dataset) => Effect.Effect<InsertDatasetEventsClient>
> {}

export const InsertDatasetEvents = Binding.Service<InsertDatasetEvents>(
  "Braintrust.InsertDatasetEvents",
);
