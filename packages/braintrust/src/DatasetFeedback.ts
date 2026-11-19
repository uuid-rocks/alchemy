import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Dataset } from "./Dataset.ts";

/** Braintrust's `createDatasetFeedback` request, without `dataset_id`. */
export interface DatasetFeedbackRequest extends Omit<
  braintrust.CreateDatasetFeedbackRequest,
  "dataset_id"
> {}

/** Add comments and corrections to records of a Braintrust dataset. */
export type DatasetFeedbackClient = (
  request: DatasetFeedbackRequest,
) => Effect.Effect<
  braintrust.FeedbackResponseSchema,
  braintrust.CreateDatasetFeedbackError,
  RuntimeContext
>;

/**
 * Add comments and corrections to records of a Braintrust dataset. Calls
 * take no `dataset_id`: the dataset is fixed by `DatasetFeedback(dataset)`.
 *
 * The host gets its own Braintrust service account and token, with `update`
 * on `dataset` for this dataset only. Braintrust has no workload identity,
 * so the token is created at deploy and bound into the host as a secret;
 * destroying the host revokes it.
 *
 * ### Adding feedback
 * **Example:** DatasetFeedback from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const project = yield* Braintrust.Project("Support", {});
 *     const dataset = yield* Braintrust.Dataset("Tickets", { projectId: project.projectId });
 *     const feedback = yield* Braintrust.DatasetFeedback(dataset);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const { id, comment } = (yield* request.json) as { id: string; comment: string };
 *         yield* feedback({ feedback: [{ id, comment }] });
 *         return yield* HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.DatasetFeedbackHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Dataset
 */
export interface DatasetFeedback extends Binding.Service<
  DatasetFeedback,
  "Braintrust.DatasetFeedback",
  (dataset: Dataset) => Effect.Effect<DatasetFeedbackClient>
> {}

export const DatasetFeedback = Binding.Service<DatasetFeedback>("Braintrust.DatasetFeedback");
