import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Dataset } from "./Dataset.ts";
import type { FetchDatasetEventsClient } from "./FetchDatasetEvents.ts";
import type { PreviewDatasetRestoreClient } from "./PreviewDatasetRestore.ts";
import type { SummarizeDatasetClient } from "./SummarizeDataset.ts";

export interface ReadDatasetClient {
  /** Read the records of a Braintrust dataset, a page at a time. */
  readonly fetch: FetchDatasetEventsClient;
  /** Summarize a Braintrust dataset: how many records it has. */
  readonly summarize: SummarizeDatasetClient;
  /** Preview restoring a Braintrust dataset to an earlier version: how many records it would restore and delete. */
  readonly previewRestore: PreviewDatasetRestoreClient;
}

/**
 * Read the dataset from a Worker, Function or any other host: `fetch`,
 * `summarize`, `previewRestore`. Calls take no `dataset_id`: the dataset is
 * fixed by `ReadDataset(dataset)`.
 *
 * The host gets its own Braintrust service account and token, with `read` on
 * `dataset` for this dataset only. Braintrust has no workload identity, so
 * the token is created at deploy and bound into the host as a secret;
 * destroying the host revokes it.
 *
 * ### Read the dataset
 * **Example:** ReadDataset from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const records = yield* Braintrust.ReadDataset(dataset);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { events, cursor } = yield* records.fetch({ limit: 100 });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.ReadDatasetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Dataset
 */
export interface ReadDataset extends Binding.Service<
  ReadDataset,
  "Braintrust.ReadDataset",
  (dataset: Dataset) => Effect.Effect<ReadDatasetClient>
> {}

export const ReadDataset = Binding.Service<ReadDataset>("Braintrust.ReadDataset");
