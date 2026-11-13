import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

/** Braintrust's `createProjectLogFeedback` request, without `project_id`. */
export interface ProjectLogFeedbackRequest extends Omit<
  braintrust.CreateProjectLogFeedbackRequest,
  "project_id"
> {}

/** Add scores, comments and corrections to log events of a Braintrust project. */
export type ProjectLogFeedbackClient = (
  request: ProjectLogFeedbackRequest,
) => Effect.Effect<
  braintrust.FeedbackResponseSchema,
  braintrust.CreateProjectLogFeedbackError,
  RuntimeContext
>;

/**
 * Add scores, comments and corrections to log events of a Braintrust
 * project. Calls take no `project_id`: the project's logs is fixed by
 * `ProjectLogFeedback(project)`.
 *
 * The host gets its own Braintrust service account and token, with `update`
 * on `project_log` for this project only. Braintrust has no workload
 * identity, so the token is created at deploy and bound into the host as a
 * secret; destroying the host revokes it.
 *
 * ### Adding feedback
 * **Example:** ProjectLogFeedback from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const feedback = yield* Braintrust.ProjectLogFeedback(project);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* feedback({ feedback: [{ id: rowId, scores: { helpful: 1 }, comment: "thumbs up" }] });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.ProjectLogFeedbackHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Project
 */
export interface ProjectLogFeedback extends Binding.Service<
  ProjectLogFeedback,
  "Braintrust.ProjectLogFeedback",
  (project: Project) => Effect.Effect<ProjectLogFeedbackClient>
> {}

export const ProjectLogFeedback = Binding.Service<ProjectLogFeedback>(
  "Braintrust.ProjectLogFeedback",
);
