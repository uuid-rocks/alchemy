import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { LaunchEval, type LaunchEvalClient } from "./LaunchEval.ts";
import type { Project } from "./Project.ts";

/**
 * HTTP implementation of {@link LaunchEval}: Braintrust's REST API with the
 * host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const launch = yield* Braintrust.LaunchEval(project).pipe(
 *   Effect.provide(Braintrust.LaunchEvalHttp),
 * );
 * ```
 *
 * @layer
 * @product Experiment
 * @provides Braintrust.LaunchEval
 */
export const LaunchEvalHttp = Layer.succeed(
  LaunchEval,
  makeHttpBinding({
    id: (project: Project) => project.projectId,
    grants: [
      { objectType: "project", permission: "read" },
      { objectType: "project", permission: "create", restrictObjectType: "experiment" },
    ],
    client:
      (auth, id): LaunchEvalClient =>
      (request) =>
        Effect.flatMap(id, (project_id) =>
          // A request variable can still carry `stream: true`; the response is read as JSON.
          auth.authorize(braintrust.createEval({ ...request, project_id, stream: false })),
        ),
  }),
);
