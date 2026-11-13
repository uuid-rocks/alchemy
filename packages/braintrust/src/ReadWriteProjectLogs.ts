import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";
import type { ReadProjectLogsClient } from "./ReadProjectLogs.ts";
import type { WriteProjectLogsClient } from "./WriteProjectLogs.ts";

/** Every call of `ReadProjectLogs` and `WriteProjectLogs`. */
export interface ReadWriteProjectLogsClient extends ReadProjectLogsClient, WriteProjectLogsClient {}

/**
 * Read and write the project's logs from a Worker, Function or any other
 * host: `fetch`, `insert`, `feedback`. Calls take no `project_id`: the
 * project's logs is fixed by `ReadWriteProjectLogs(project)`.
 *
 * The host gets its own Braintrust service account and token, with `read`
 * and `update` on `project_log` for this project only. Braintrust has no
 * workload identity, so the token is created at deploy and bound into the
 * host as a secret; destroying the host revokes it.
 *
 * ### Read and write the project's logs
 * **Example:** ReadWriteProjectLogs from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const logs = yield* Braintrust.ReadWriteProjectLogs(project);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { events, cursor } = yield* logs.fetch({ limit: 100 });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.ReadWriteProjectLogsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Project
 */
export interface ReadWriteProjectLogs extends Binding.Service<
  ReadWriteProjectLogs,
  "Braintrust.ReadWriteProjectLogs",
  (project: Project) => Effect.Effect<ReadWriteProjectLogsClient>
> {}

export const ReadWriteProjectLogs = Binding.Service<ReadWriteProjectLogs>(
  "Braintrust.ReadWriteProjectLogs",
);
