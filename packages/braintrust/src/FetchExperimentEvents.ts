import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Experiment } from "./Experiment.ts";

/** Braintrust's `fetchExperimentEvents` request, without `experiment_id`. */
export interface FetchExperimentEventsRequest extends Omit<
  braintrust.FetchExperimentEventsRequest,
  "experiment_id"
> {}

/** Read the events of a Braintrust experiment, a page at a time. */
export type FetchExperimentEventsClient = (
  request?: FetchExperimentEventsRequest,
) => Effect.Effect<
  braintrust.FetchExperimentEventsResponse,
  braintrust.FetchExperimentEventsError,
  RuntimeContext
>;

/**
 * Read the events of a Braintrust experiment, a page at a time. Calls take
 * no `experiment_id`: the experiment is fixed by
 * `FetchExperimentEvents(experiment)`.
 *
 * The host gets its own Braintrust service account and token, with `read` on
 * `experiment` for this experiment only. Braintrust has no workload
 * identity, so the token is created at deploy and bound into the host as a
 * secret; destroying the host revokes it.
 *
 * ### Reading events
 * **Example:** FetchExperimentEvents from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const project = yield* Braintrust.Project("Support", {});
 *     const experiment = yield* Braintrust.Experiment("Baseline", { projectId: project.projectId });
 *     const fetch = yield* Braintrust.FetchExperimentEvents(experiment);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { events } = yield* fetch({ limit: 100 });
 *         return yield* HttpServerResponse.json(events);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.FetchExperimentEventsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Experiment
 */
export interface FetchExperimentEvents extends Binding.Service<
  FetchExperimentEvents,
  "Braintrust.FetchExperimentEvents",
  (experiment: Experiment) => Effect.Effect<FetchExperimentEventsClient>
> {}

export const FetchExperimentEvents = Binding.Service<FetchExperimentEvents>(
  "Braintrust.FetchExperimentEvents",
);
