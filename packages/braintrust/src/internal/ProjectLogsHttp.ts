/**
 * Shared scaffolding for the bindings on the project's logs: the grants, and the
 * client methods each `<Op>Http.ts` and `Read`/`Write`/`ReadWrite` layer
 * picks from. Lives in `internal/`, so the published package doesn't expose it.
 */
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Effect from "effect/Effect";
import type { BraintrustAuth, Grant } from "../BraintrustBindings.ts";
import type { FetchProjectLogsClient } from "../FetchProjectLogs.ts";
import type { InsertProjectLogsClient } from "../InsertProjectLogs.ts";
import type { Project } from "../Project.ts";
import type { ProjectLogFeedbackClient } from "../ProjectLogFeedback.ts";

export const projectId = (project: Project) => project.projectId;

export const PROJECT_LOG_READ: Grant = { objectType: "project_log", permission: "read" };
export const PROJECT_LOG_UPDATE: Grant = { objectType: "project_log", permission: "update" };

/** Every client method on the project's logs, each sending the bound id. */
export const projectClients = (auth: BraintrustAuth, id: Effect.Effect<string>) => ({
  insert: ((request) =>
    Effect.flatMap(id, (project_id) =>
      auth.authorize(braintrust.insertProjectLogEvents({ ...request, project_id })),
    )) satisfies InsertProjectLogsClient,
  fetch: ((request = {}) =>
    Effect.flatMap(id, (project_id) =>
      auth.authorize(braintrust.fetchProjectLogEvents({ ...request, project_id })),
    )) satisfies FetchProjectLogsClient,
  feedback: ((request) =>
    Effect.flatMap(id, (project_id) =>
      auth.authorize(braintrust.createProjectLogFeedback({ ...request, project_id })),
    )) satisfies ProjectLogFeedbackClient,
});
