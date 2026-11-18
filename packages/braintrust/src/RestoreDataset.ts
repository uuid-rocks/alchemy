import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Dataset } from "./Dataset.ts";

/** Braintrust's `restoreDataset` request, without `dataset_id`. */
export interface RestoreDatasetRequest extends Omit<
  braintrust.RestoreDatasetRequest,
  "dataset_id"
> {}

/** Restore a Braintrust dataset to an earlier version. */
export type RestoreDatasetClient = (
  request: RestoreDatasetRequest,
) => Effect.Effect<
  braintrust.DatasetRestoreResponse,
  braintrust.RestoreDatasetError,
  RuntimeContext
>;

/**
 * Restore a Braintrust dataset to an earlier version: records added since
 * that version are deleted, and records deleted since are brought back.
 * Calls take no `dataset_id`: the dataset is fixed by
 * `RestoreDataset(dataset)`.
 *
 * The host gets its own Braintrust service account and token, with `update`
 * and `delete` on `dataset` for this dataset only. Braintrust checks a
 * restore's deletions as `delete` on the dataset, and that permission also
 * lets the token delete the dataset itself, so `WriteDataset` and
 * `ReadWriteDataset` leave restore out. Braintrust has no workload
 * identity, so the token is created at deploy and bound into the host as a
 * secret; destroying the host revokes it.
 *
 * ### Restoring a version
 * **Example:** RestoreDataset from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const project = yield* Braintrust.Project("Support", {});
 *     const dataset = yield* Braintrust.Dataset("Tickets", { projectId: project.projectId });
 *     const restore = yield* Braintrust.RestoreDataset(dataset);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const { version } = (yield* request.json) as { version: string };
 *         const restored = yield* restore({ version });
 *         return yield* HttpServerResponse.json(restored);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.RestoreDatasetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Dataset
 */
export interface RestoreDataset extends Binding.Service<
  RestoreDataset,
  "Braintrust.RestoreDataset",
  (dataset: Dataset) => Effect.Effect<RestoreDatasetClient>
> {}

export const RestoreDataset = Binding.Service<RestoreDataset>("Braintrust.RestoreDataset");
