import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { PROJECT_LOG_UPDATE, projectClients, projectId } from "./ProjectLogsHttp.ts";
import { WriteProjectLogs, type WriteProjectLogsClient } from "./WriteProjectLogs.ts";

/**
 * HTTP implementation of {@link WriteProjectLogs}: Braintrust's REST API
 * with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const logs = yield* Braintrust.WriteProjectLogs(project).pipe(
 *   Effect.provide(Braintrust.WriteProjectLogsHttp),
 * );
 * ```
 *
 * @layer
 * @product Project
 * @provides Braintrust.WriteProjectLogs
 */
export const WriteProjectLogsHttp = Layer.succeed(
  WriteProjectLogs,
  makeHttpBinding({
    id: projectId,
    grants: [PROJECT_LOG_UPDATE],
    client: (auth, id): WriteProjectLogsClient => {
      const clients = projectClients(auth, id);
      return {
        insert: clients.insert,
        feedback: clients.feedback,
      };
    },
  }),
);
