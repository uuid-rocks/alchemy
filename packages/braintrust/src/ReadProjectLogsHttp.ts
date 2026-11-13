import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { PROJECT_LOG_READ, projectClients, projectId } from "./ProjectLogsHttp.ts";
import { ReadProjectLogs, type ReadProjectLogsClient } from "./ReadProjectLogs.ts";

/**
 * HTTP implementation of {@link ReadProjectLogs}: Braintrust's REST API with
 * the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const logs = yield* Braintrust.ReadProjectLogs(project);
 *   // ...
 * }).pipe(Effect.provide(Braintrust.ReadProjectLogsHttp))
 * ```
 *
 * @layer
 * @product Project
 * @provides Braintrust.ReadProjectLogs
 */
export const ReadProjectLogsHttp = Layer.succeed(
  ReadProjectLogs,
  makeHttpBinding({
    id: projectId,
    grants: [PROJECT_LOG_READ],
    client: (auth, id): ReadProjectLogsClient => {
      const clients = projectClients(auth, id);
      return {
        fetch: clients.fetch,
      };
    },
  }),
);
