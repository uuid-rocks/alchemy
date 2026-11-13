import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Project } from "./Project.ts";

/** Braintrust's `insertProjectLogEvents` request, without `project_id`. */
export interface InsertProjectLogsRequest extends Omit<
  braintrust.InsertProjectLogEventsRequest,
  "project_id"
> {}

/** Log events to a Braintrust project. */
export type InsertProjectLogsClient = (
  request: InsertProjectLogsRequest,
) => Effect.Effect<
  braintrust.InsertEventsResponse,
  braintrust.InsertProjectLogEventsError,
  RuntimeContext
>;

/**
 * Log events to a Braintrust project. Calls take no `project_id`: the
 * project's logs is fixed by `InsertProjectLogs(project)`.
 *
 * The host gets its own Braintrust service account and token, with `update`
 * on `project_log` for this project only. Braintrust has no workload
 * identity, so the token is created at deploy and bound into the host as a
 * secret; destroying the host revokes it.
 *
 * ### Logging events
 * **Example:** InsertProjectLogs from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const insert = yield* Braintrust.InsertProjectLogs(project);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { row_ids } = yield* insert({
 *           events: [{ input: { question }, output: answer, metadata: { model: "gpt-4.1" } }],
 *         });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.InsertProjectLogsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Project
 */
export interface InsertProjectLogs extends Binding.Service<
  InsertProjectLogs,
  "Braintrust.InsertProjectLogs",
  (project: Project) => Effect.Effect<InsertProjectLogsClient>
> {}

export const InsertProjectLogs = Binding.Service<InsertProjectLogs>("Braintrust.InsertProjectLogs");
