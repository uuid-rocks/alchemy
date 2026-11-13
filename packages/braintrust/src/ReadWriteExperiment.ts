import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Experiment } from "./Experiment.ts";
import type { ReadExperimentClient } from "./ReadExperiment.ts";
import type { WriteExperimentClient } from "./WriteExperiment.ts";

/** Every call of `ReadExperiment` and `WriteExperiment`. */
export interface ReadWriteExperimentClient extends ReadExperimentClient, WriteExperimentClient {}

/**
 * Read and write the experiment from a Worker, Function or any other host:
 * `fetch`, `summarize`, `insert`, `feedback`. Calls take no `experiment_id`:
 * the experiment is fixed by `ReadWriteExperiment(experiment)`.
 *
 * The host gets its own Braintrust service account and token, with `read`
 * and `update` on `experiment` for this experiment only. Braintrust has no
 * workload identity, so the token is created at deploy and bound into the
 * host as a secret; destroying the host revokes it.
 *
 * ### Read and write the experiment
 * **Example:** ReadWriteExperiment from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const experimentEvents = yield* Braintrust.ReadWriteExperiment(experiment);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { events, cursor } = yield* experimentEvents.fetch({ limit: 100 });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.ReadWriteExperimentHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Experiment
 */
export interface ReadWriteExperiment extends Binding.Service<
  ReadWriteExperiment,
  "Braintrust.ReadWriteExperiment",
  (experiment: Experiment) => Effect.Effect<ReadWriteExperimentClient>
> {}

export const ReadWriteExperiment = Binding.Service<ReadWriteExperiment>(
  "Braintrust.ReadWriteExperiment",
);
