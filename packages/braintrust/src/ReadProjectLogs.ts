import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { FetchProjectLogsClient } from "./FetchProjectLogs.ts";
import type { Project } from "./Project.ts";

export interface ReadProjectLogsClient {
  /** Read the log events of a Braintrust project, a page at a time. */
  readonly fetch: FetchProjectLogsClient;
}

/**
 * Read the project's logs from a Worker, Function or any other host:
 * `fetch`. Calls take no `project_id`: the project's logs is fixed by
 * `ReadProjectLogs(project)`.
 *
 * The host gets its own Braintrust service account and token, with `read` on
 * `project_log` for this project only. Braintrust has no workload identity,
 * so the token is created at deploy and bound into the host as a secret;
 * destroying the host revokes it.
 *
 * ### Read the project's logs
 * **Example:** ReadProjectLogs from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const logs = yield* Braintrust.ReadProjectLogs(project);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { events, cursor } = yield* logs.fetch({ limit: 100 });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.ReadProjectLogsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Project
 */
export interface ReadProjectLogs extends Binding.Service<
  ReadProjectLogs,
  "Braintrust.ReadProjectLogs",
  (project: Project) => Effect.Effect<ReadProjectLogsClient>
> {}

export const ReadProjectLogs = Binding.Service<ReadProjectLogs>("Braintrust.ReadProjectLogs");
