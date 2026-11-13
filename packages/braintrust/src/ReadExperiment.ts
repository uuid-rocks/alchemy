import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Experiment } from "./Experiment.ts";
import type { FetchExperimentEventsClient } from "./FetchExperimentEvents.ts";
import type { SummarizeExperimentClient } from "./SummarizeExperiment.ts";

export interface ReadExperimentClient {
  /** Read the events of a Braintrust experiment, a page at a time. */
  readonly fetch: FetchExperimentEventsClient;
  /** Summarize the scores and metrics of a Braintrust experiment. */
  readonly summarize: SummarizeExperimentClient;
}

/**
 * Read the experiment from a Worker, Function or any other host: `fetch`,
 * `summarize`. Calls take no `experiment_id`: the experiment is fixed by
 * `ReadExperiment(experiment)`.
 *
 * The host gets its own Braintrust service account and token, with `read` on
 * `experiment` for this experiment only. Braintrust has no workload
 * identity, so the token is created at deploy and bound into the host as a
 * secret; destroying the host revokes it.
 *
 * ### Read the experiment
 * **Example:** ReadExperiment from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const experimentEvents = yield* Braintrust.ReadExperiment(experiment);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { events, cursor } = yield* experimentEvents.fetch({ limit: 100 });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.ReadExperimentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Experiment
 */
export interface ReadExperiment extends Binding.Service<
  ReadExperiment,
  "Braintrust.ReadExperiment",
  (experiment: Experiment) => Effect.Effect<ReadExperimentClient>
> {}

export const ReadExperiment = Binding.Service<ReadExperiment>("Braintrust.ReadExperiment");
