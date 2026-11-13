import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Experiment } from "./Experiment.ts";
import type { ExperimentFeedbackClient } from "./ExperimentFeedback.ts";
import type { InsertExperimentEventsClient } from "./InsertExperimentEvents.ts";

export interface WriteExperimentClient {
  /** Record eval results in a Braintrust experiment. */
  readonly insert: InsertExperimentEventsClient;
  /** Add scores, comments and corrections to events of a Braintrust experiment. */
  readonly feedback: ExperimentFeedbackClient;
}

/**
 * Write to the experiment from a Worker, Function or any other host:
 * `insert`, `feedback`. Calls take no `experiment_id`: the experiment is
 * fixed by `WriteExperiment(experiment)`.
 *
 * The host gets its own Braintrust service account and token, with `update`
 * on `experiment` for this experiment only. Braintrust has no workload
 * identity, so the token is created at deploy and bound into the host as a
 * secret; destroying the host revokes it.
 *
 * ### Write to the experiment
 * **Example:** WriteExperiment from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const experimentEvents = yield* Braintrust.WriteExperiment(experiment);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* experimentEvents.insert({
 *           events: [{ input, output, expected, scores: { exact: output === expected ? 1 : 0 } }],
 *         });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.WriteExperimentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Experiment
 */
export interface WriteExperiment extends Binding.Service<
  WriteExperiment,
  "Braintrust.WriteExperiment",
  (experiment: Experiment) => Effect.Effect<WriteExperimentClient>
> {}

export const WriteExperiment = Binding.Service<WriteExperiment>("Braintrust.WriteExperiment");
