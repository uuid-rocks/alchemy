import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Experiment } from "./Experiment.ts";

/** Braintrust's `insertExperimentEvents` request, without `experiment_id`. */
export interface InsertExperimentEventsRequest extends Omit<
  braintrust.InsertExperimentEventsRequest,
  "experiment_id"
> {}

/** Record eval results in a Braintrust experiment. */
export type InsertExperimentEventsClient = (
  request: InsertExperimentEventsRequest,
) => Effect.Effect<
  braintrust.InsertEventsResponse,
  braintrust.InsertExperimentEventsError,
  RuntimeContext
>;

/**
 * Record eval results in a Braintrust experiment. Calls take no
 * `experiment_id`: the experiment is fixed by
 * `InsertExperimentEvents(experiment)`.
 *
 * The host gets its own Braintrust service account and token, with `update`
 * on `experiment` for this experiment only. Braintrust has no workload
 * identity, so the token is created at deploy and bound into the host as a
 * secret; destroying the host revokes it.
 *
 * ### Recording results
 * **Example:** InsertExperimentEvents from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const insert = yield* Braintrust.InsertExperimentEvents(experiment);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* insert({
 *           events: [{ input, output, expected, scores: { exact: output === expected ? 1 : 0 } }],
 *         });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.InsertExperimentEventsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Experiment
 */
export interface InsertExperimentEvents extends Binding.Service<
  InsertExperimentEvents,
  "Braintrust.InsertExperimentEvents",
  (experiment: Experiment) => Effect.Effect<InsertExperimentEventsClient>
> {}

export const InsertExperimentEvents = Binding.Service<InsertExperimentEvents>(
  "Braintrust.InsertExperimentEvents",
);
