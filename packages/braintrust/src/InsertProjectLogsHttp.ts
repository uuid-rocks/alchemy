import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { InsertProjectLogs } from "./InsertProjectLogs.ts";
import { PROJECT_LOG_UPDATE, projectClients, projectId } from "./ProjectLogsHttp.ts";

/**
 * HTTP implementation of {@link InsertProjectLogs}: Braintrust's REST API
 * with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const insert = yield* Braintrust.InsertProjectLogs(project).pipe(
 *   Effect.provide(Braintrust.InsertProjectLogsHttp),
 * );
 * ```
 *
 * @layer
 * @product Project
 * @provides Braintrust.InsertProjectLogs
 */
export const InsertProjectLogsHttp = Layer.succeed(
  InsertProjectLogs,
  makeHttpBinding({
    id: projectId,
    grants: [PROJECT_LOG_UPDATE],
    client: (auth, id) => projectClients(auth, id).insert,
  }),
);
