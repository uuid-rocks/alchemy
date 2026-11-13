import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Dataset } from "./Dataset.ts";

/** Braintrust's `previewDatasetRestore` request, without `dataset_id`. */
export interface PreviewDatasetRestoreRequest extends Omit<
  braintrust.PreviewDatasetRestoreRequest,
  "dataset_id"
> {}

/** Preview restoring a Braintrust dataset to an earlier version: how many records it would restore and delete. */
export type PreviewDatasetRestoreClient = (
  request: PreviewDatasetRestoreRequest,
) => Effect.Effect<
  braintrust.DatasetRestorePreviewResponse,
  braintrust.PreviewDatasetRestoreError,
  RuntimeContext
>;

/**
 * Preview restoring a Braintrust dataset to an earlier version: how many
 * records it would restore and delete. Calls take no `dataset_id`: the
 * dataset is fixed by `PreviewDatasetRestore(dataset)`.
 *
 * The host gets its own Braintrust service account and token, with `read` on
 * `dataset` for this dataset only. Braintrust has no workload identity, so
 * the token is created at deploy and bound into the host as a secret;
 * destroying the host revokes it.
 *
 * ### Previewing a restore
 * **Example:** PreviewDatasetRestore from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const previewRestore = yield* Braintrust.PreviewDatasetRestore(dataset);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { rows_to_restore, rows_to_delete } = yield* previewRestore({ version });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.PreviewDatasetRestoreHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Dataset
 */
export interface PreviewDatasetRestore extends Binding.Service<
  PreviewDatasetRestore,
  "Braintrust.PreviewDatasetRestore",
  (dataset: Dataset) => Effect.Effect<PreviewDatasetRestoreClient>
> {}

export const PreviewDatasetRestore = Binding.Service<PreviewDatasetRestore>(
  "Braintrust.PreviewDatasetRestore",
);
