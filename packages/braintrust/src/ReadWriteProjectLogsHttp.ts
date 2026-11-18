import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import {
  PROJECT_LOG_READ,
  PROJECT_LOG_UPDATE,
  projectClients,
  projectId,
} from "./internal/ProjectLogsHttp.ts";
import { ReadWriteProjectLogs, type ReadWriteProjectLogsClient } from "./ReadWriteProjectLogs.ts";

/**
 * HTTP implementation of {@link ReadWriteProjectLogs}: Braintrust's REST API
 * with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const logs = yield* Braintrust.ReadWriteProjectLogs(project).pipe(
 *   Effect.provide(Braintrust.ReadWriteProjectLogsHttp),
 * );
 * ```
 *
 * @layer
 * @product Project
 * @provides Braintrust.ReadWriteProjectLogs
 */
export const ReadWriteProjectLogsHttp = Layer.succeed(
  ReadWriteProjectLogs,
  makeHttpBinding({
    id: projectId,
    grants: [PROJECT_LOG_READ, PROJECT_LOG_UPDATE],
    client: (auth, id): ReadWriteProjectLogsClient => {
      const clients = projectClients(auth, id);
      return {
        fetch: clients.fetch,
        insert: clients.insert,
        feedback: clients.feedback,
      };
    },
  }),
);
