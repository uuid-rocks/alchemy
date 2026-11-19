import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Dataset } from "./Dataset.ts";
import type { DatasetFeedbackClient } from "./DatasetFeedback.ts";
import type { InsertDatasetEventsClient } from "./InsertDatasetEvents.ts";

export interface WriteDatasetClient {
  /** Add or update records in a Braintrust dataset. */
  readonly insert: InsertDatasetEventsClient;
  /** Add comments and corrections to records of a Braintrust dataset. */
  readonly feedback: DatasetFeedbackClient;
}

/**
 * Write to the dataset from a Worker, Function or any other host: `insert`,
 * `feedback`. Calls take no `dataset_id`: the dataset is fixed by
 * `WriteDataset(dataset)`. To restore an earlier version, bind
 * `RestoreDataset`.
 *
 * The host gets its own Braintrust service account and token, with `update`
 * on `dataset` for this dataset only. Braintrust has no workload identity,
 * so the token is created at deploy and bound into the host as a secret;
 * destroying the host revokes it.
 *
 * ### Write to the dataset
 * **Example:** WriteDataset from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const project = yield* Braintrust.Project("Support", {});
 *     const dataset = yield* Braintrust.Dataset("Tickets", { projectId: project.projectId });
 *     const records = yield* Braintrust.WriteDataset(dataset);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const { question, answer } = (yield* request.json) as { question: string; answer: string };
 *         yield* records.insert({ events: [{ input: { question }, expected: answer }] });
 *         return yield* HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.WriteDatasetHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Dataset
 */
export interface WriteDataset extends Binding.Service<
  WriteDataset,
  "Braintrust.WriteDataset",
  (dataset: Dataset) => Effect.Effect<WriteDatasetClient>
> {}

export const WriteDataset = Binding.Service<WriteDataset>("Braintrust.WriteDataset");
