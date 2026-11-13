import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Experiment } from "./Experiment.ts";

/** Braintrust's `createExperimentFeedback` request, without `experiment_id`. */
export interface ExperimentFeedbackRequest extends Omit<
  braintrust.CreateExperimentFeedbackRequest,
  "experiment_id"
> {}

/** Add scores, comments and corrections to events of a Braintrust experiment. */
export type ExperimentFeedbackClient = (
  request: ExperimentFeedbackRequest,
) => Effect.Effect<
  braintrust.FeedbackResponseSchema,
  braintrust.CreateExperimentFeedbackError,
  RuntimeContext
>;

/**
 * Add scores, comments and corrections to events of a Braintrust experiment.
 * Calls take no `experiment_id`: the experiment is fixed by
 * `ExperimentFeedback(experiment)`.
 *
 * The host gets its own Braintrust service account and token, with `update`
 * on `experiment` for this experiment only. Braintrust has no workload
 * identity, so the token is created at deploy and bound into the host as a
 * secret; destroying the host revokes it.
 *
 * ### Adding feedback
 * **Example:** ExperimentFeedback from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const feedback = yield* Braintrust.ExperimentFeedback(experiment);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* feedback({ feedback: [{ id: rowId, scores: { reviewed: 1 } }] });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.ExperimentFeedbackHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Experiment
 */
export interface ExperimentFeedback extends Binding.Service<
  ExperimentFeedback,
  "Braintrust.ExperimentFeedback",
  (experiment: Experiment) => Effect.Effect<ExperimentFeedbackClient>
> {}

export const ExperimentFeedback = Binding.Service<ExperimentFeedback>(
  "Braintrust.ExperimentFeedback",
);
