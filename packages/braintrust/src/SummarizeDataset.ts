import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Dataset } from "./Dataset.ts";

/** Braintrust's `summarizeDataset` request, without `dataset_id`. */
export interface SummarizeDatasetRequest extends Omit<
  braintrust.SummarizeDatasetRequest,
  "dataset_id"
> {}

/** Summarize a Braintrust dataset: how many records it has. */
export type SummarizeDatasetClient = (
  request?: SummarizeDatasetRequest,
) => Effect.Effect<
  braintrust.SummarizeDatasetResponse,
  braintrust.SummarizeDatasetError,
  RuntimeContext
>;

/**
 * Summarize a Braintrust dataset: how many records it has. Calls take no
 * `dataset_id`: the dataset is fixed by `SummarizeDataset(dataset)`.
 *
 * The host gets its own Braintrust service account and token, with `read` on
 * `dataset` for this dataset only. Braintrust has no workload identity, so
 * the token is created at deploy and bound into the host as a secret;
 * destroying the host revokes it.
 *
 * ### Summarizing
 * **Example:** SummarizeDataset from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const project = yield* Braintrust.Project("Support", {});
 *     const dataset = yield* Braintrust.Dataset("Tickets", { projectId: project.projectId });
 *     const summarize = yield* Braintrust.SummarizeDataset(dataset);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { data_summary } = yield* summarize({ summarize_data: true });
 *         return yield* HttpServerResponse.json({ records: data_summary?.total_records });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.SummarizeDatasetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Dataset
 */
export interface SummarizeDataset extends Binding.Service<
  SummarizeDataset,
  "Braintrust.SummarizeDataset",
  (dataset: Dataset) => Effect.Effect<SummarizeDatasetClient>
> {}

export const SummarizeDataset = Binding.Service<SummarizeDataset>("Braintrust.SummarizeDataset");
