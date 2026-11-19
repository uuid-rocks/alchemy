import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

/** Braintrust's `fetchProjectLogEvents` request, without `project_id`. */
export interface FetchProjectLogsRequest extends Omit<
  braintrust.FetchProjectLogEventsRequest,
  "project_id"
> {}

/** Read the log events of a Braintrust project, a page at a time. */
export type FetchProjectLogsClient = (
  request?: FetchProjectLogsRequest,
) => Effect.Effect<
  braintrust.FetchProjectLogsEventsResponse,
  braintrust.FetchProjectLogEventsError,
  RuntimeContext
>;

/**
 * Read the log events of a Braintrust project, a page at a time. Calls take
 * no `project_id`: the project's logs is fixed by
 * `FetchProjectLogs(project)`.
 *
 * The host gets its own Braintrust service account and token, with `read` on
 * `project_log` for this project only. Braintrust has no workload identity,
 * so the token is created at deploy and bound into the host as a secret;
 * destroying the host revokes it.
 *
 * ### Reading logs
 * **Example:** FetchProjectLogs from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const project = yield* Braintrust.Project("Support", {});
 *     const fetch = yield* Braintrust.FetchProjectLogs(project);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { events } = yield* fetch({ limit: 100 });
 *         return yield* HttpServerResponse.json(events);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.FetchProjectLogsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Project
 */
export interface FetchProjectLogs extends Binding.Service<
  FetchProjectLogs,
  "Braintrust.FetchProjectLogs",
  (project: Project) => Effect.Effect<FetchProjectLogsClient>
> {}

export const FetchProjectLogs = Binding.Service<FetchProjectLogs>("Braintrust.FetchProjectLogs");
