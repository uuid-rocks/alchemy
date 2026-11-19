import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { InsertProjectLogsClient } from "./InsertProjectLogs.ts";
import type { Project } from "./Project.ts";
import type { ProjectLogFeedbackClient } from "./ProjectLogFeedback.ts";

export interface WriteProjectLogsClient {
  /** Log events to a Braintrust project. */
  readonly insert: InsertProjectLogsClient;
  /** Add scores, comments and corrections to log events of a Braintrust project. */
  readonly feedback: ProjectLogFeedbackClient;
}

/**
 * Write to the project's logs from a Worker, Function or any other host:
 * `insert`, `feedback`. Calls take no `project_id`: the project's logs is
 * fixed by `WriteProjectLogs(project)`.
 *
 * The host gets its own Braintrust service account and token, with `update`
 * on `project_log` for this project only. Braintrust has no workload
 * identity, so the token is created at deploy and bound into the host as a
 * secret; destroying the host revokes it.
 *
 * ### Write to the project's logs
 * **Example:** WriteProjectLogs from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const project = yield* Braintrust.Project("Support", {});
 *     const logs = yield* Braintrust.WriteProjectLogs(project);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const question = yield* request.text;
 *         const { row_ids } = yield* logs.insert({ events: [{ input: question, metadata: { route: "/ask" } }] });
 *         return yield* HttpServerResponse.json({ rowId: row_ids[0] });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.WriteProjectLogsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Project
 */
export interface WriteProjectLogs extends Binding.Service<
  WriteProjectLogs,
  "Braintrust.WriteProjectLogs",
  (project: Project) => Effect.Effect<WriteProjectLogsClient>
> {}

export const WriteProjectLogs = Binding.Service<WriteProjectLogs>("Braintrust.WriteProjectLogs");
