import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { FetchProjectLogs } from "./FetchProjectLogs.ts";
import { PROJECT_LOG_READ, projectClients, projectId } from "./ProjectLogsHttp.ts";

/**
 * HTTP implementation of {@link FetchProjectLogs}: Braintrust's REST API
 * with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const fetch = yield* Braintrust.FetchProjectLogs(project);
 *   // ...
 * }).pipe(Effect.provide(Braintrust.FetchProjectLogsHttp))
 * ```
 *
 * @layer
 * @product Project
 * @provides Braintrust.FetchProjectLogs
 */
export const FetchProjectLogsHttp = Layer.succeed(
  FetchProjectLogs,
  makeHttpBinding({
    id: projectId,
    grants: [PROJECT_LOG_READ],
    client: (auth, id) => projectClients(auth, id).fetch,
  }),
);
