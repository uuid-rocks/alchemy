import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Dataset } from "./Dataset.ts";
import type { ReadDatasetClient } from "./ReadDataset.ts";
import type { WriteDatasetClient } from "./WriteDataset.ts";

/** Every call of `ReadDataset` and `WriteDataset`. */
export interface ReadWriteDatasetClient extends ReadDatasetClient, WriteDatasetClient {}

/**
 * Read and write the dataset from a Worker, Function or any other host:
 * `fetch`, `summarize`, `previewRestore`, `insert`, `feedback`, `restore`.
 * Calls take no `dataset_id`: the dataset is fixed by
 * `ReadWriteDataset(dataset)`.
 *
 * The host gets its own Braintrust service account and token, with `read`
 * and `update` on `dataset` for this dataset only. Braintrust has no
 * workload identity, so the token is created at deploy and bound into the
 * host as a secret; destroying the host revokes it.
 *
 * ### Read and write the dataset
 * **Example:** ReadWriteDataset from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const records = yield* Braintrust.ReadWriteDataset(dataset);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { events, cursor } = yield* records.fetch({ limit: 100 });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.ReadWriteDatasetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Dataset
 */
export interface ReadWriteDataset extends Binding.Service<
  ReadWriteDataset,
  "Braintrust.ReadWriteDataset",
  (dataset: Dataset) => Effect.Effect<ReadWriteDatasetClient>
> {}

export const ReadWriteDataset = Binding.Service<ReadWriteDataset>("Braintrust.ReadWriteDataset");
