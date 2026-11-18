import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { ProjectLogFeedback } from "./ProjectLogFeedback.ts";
import { PROJECT_LOG_UPDATE, projectClients, projectId } from "./ProjectLogsHttp.ts";

/**
 * HTTP implementation of {@link ProjectLogFeedback}: Braintrust's REST API
 * with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const feedback = yield* Braintrust.ProjectLogFeedback(project).pipe(
 *   Effect.provide(Braintrust.ProjectLogFeedbackHttp),
 * );
 * ```
 *
 * @layer
 * @product Project
 * @provides Braintrust.ProjectLogFeedback
 */
export const ProjectLogFeedbackHttp = Layer.succeed(
  ProjectLogFeedback,
  makeHttpBinding({
    id: projectId,
    grants: [PROJECT_LOG_UPDATE],
    client: (auth, id) => projectClients(auth, id).feedback,
  }),
);
