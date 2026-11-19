import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Experiment } from "./Experiment.ts";

/** Braintrust's `summarizeExperiment` request, without `experiment_id`. */
export interface SummarizeExperimentRequest extends Omit<
  braintrust.SummarizeExperimentRequest,
  "experiment_id"
> {}

/** Summarize the scores and metrics of a Braintrust experiment. */
export type SummarizeExperimentClient = (
  request?: SummarizeExperimentRequest,
) => Effect.Effect<
  braintrust.SummarizeExperimentResponse,
  braintrust.SummarizeExperimentError,
  RuntimeContext
>;

/**
 * Summarize the scores and metrics of a Braintrust experiment. Calls take no
 * `experiment_id`: the experiment is fixed by
 * `SummarizeExperiment(experiment)`.
 *
 * The host gets its own Braintrust service account and token, with `read` on
 * `experiment` for this experiment only. Braintrust has no workload
 * identity, so the token is created at deploy and bound into the host as a
 * secret; destroying the host revokes it.
 *
 * ### Summarizing
 * **Example:** SummarizeExperiment from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const project = yield* Braintrust.Project("Support", {});
 *     const experiment = yield* Braintrust.Experiment("Baseline", { projectId: project.projectId });
 *     const summarize = yield* Braintrust.SummarizeExperiment(experiment);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { scores } = yield* summarize({ summarize_scores: true });
 *         return yield* HttpServerResponse.json(scores);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.SummarizeExperimentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Experiment
 */
export interface SummarizeExperiment extends Binding.Service<
  SummarizeExperiment,
  "Braintrust.SummarizeExperiment",
  (experiment: Experiment) => Effect.Effect<SummarizeExperimentClient>
> {}

export const SummarizeExperiment = Binding.Service<SummarizeExperiment>(
  "Braintrust.SummarizeExperiment",
);
