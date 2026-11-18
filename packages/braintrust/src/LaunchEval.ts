import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

/**
 * Braintrust's `createEval` request, without `project_id`, and without
 * `stream`: responses are parsed as JSON.
 */
export interface LaunchEvalRequest extends Omit<
  braintrust.CreateEvalRequest,
  "project_id" | "stream"
> {}

/** Run an eval in the bound project and return the new experiment's summary. */
export type LaunchEvalClient = (
  request: LaunchEvalRequest,
) => Effect.Effect<braintrust.CreateEvalResponse, braintrust.CreateEvalError, RuntimeContext>;

/**
 * Run an eval in a Braintrust project: Braintrust runs the task over the
 * data, scores the results, records them in a new experiment, and returns
 * its summary. Calls take no `project_id`: the project is fixed by
 * `LaunchEval(project)`.
 *
 * The host gets its own Braintrust service account and token, with `read` on
 * the project and `create` on experiments in it. `read` on the project
 * covers everything inside it (datasets, functions, experiments and logs),
 * because an eval reads its data, task and scorers from there. A task or
 * scorer that calls a model also needs the AI secret it uses: bind one of
 * the proxy bindings (`Braintrust.ProxyChatCompletions(secret)`) too.
 * Braintrust has no workload identity, so the token is created at deploy and
 * bound into the host as a secret; destroying the host revokes it.
 *
 * `stream: true` isn't supported; responses are parsed as JSON.
 *
 * ### Running an eval
 * **Example:** LaunchEval from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const project = yield* Braintrust.Project("Support", {});
 *     const dataset = yield* Braintrust.Dataset("Tickets", { projectId: project.projectId });
 *     const datasetId = yield* dataset.datasetId;
 *     const launch = yield* Braintrust.LaunchEval(project);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const dataset_id = yield* datasetId;
 *         const summary = yield* launch({
 *           data: { dataset_id },
 *           task: { global_function: "ExactMatch" },
 *           scores: [{ global_function: "ExactMatch" }],
 *         });
 *         return yield* HttpServerResponse.json(summary.scores);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.LaunchEvalHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Experiment
 */
export interface LaunchEval extends Binding.Service<
  LaunchEval,
  "Braintrust.LaunchEval",
  (project: Project) => Effect.Effect<LaunchEvalClient>
> {}

export const LaunchEval = Binding.Service<LaunchEval>("Braintrust.LaunchEval");
