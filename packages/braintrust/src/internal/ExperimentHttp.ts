/**
 * Shared scaffolding for the bindings on the experiment: the grants, and the
 * client methods each `<Op>Http.ts` and `Read`/`Write`/`ReadWrite` layer
 * picks from. Lives in `internal/`, so the published package doesn't expose it.
 */
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Effect from "effect/Effect";
import type { BraintrustAuth, Grant } from "../BraintrustBindings.ts";
import type { Experiment } from "../Experiment.ts";
import type { ExperimentFeedbackClient } from "../ExperimentFeedback.ts";
import type { FetchExperimentEventsClient } from "../FetchExperimentEvents.ts";
import type { InsertExperimentEventsClient } from "../InsertExperimentEvents.ts";
import type { SummarizeExperimentClient } from "../SummarizeExperiment.ts";

export const experimentId = (experiment: Experiment) => experiment.experimentId;

export const EXPERIMENT_READ: Grant = { objectType: "experiment", permission: "read" };
export const EXPERIMENT_UPDATE: Grant = { objectType: "experiment", permission: "update" };

/** Every client method on the experiment, each sending the bound id. */
export const experimentClients = (auth: BraintrustAuth, id: Effect.Effect<string>) => ({
  insert: ((request) =>
    Effect.flatMap(id, (experiment_id) =>
      auth.authorize(braintrust.insertExperimentEvents({ ...request, experiment_id })),
    )) satisfies InsertExperimentEventsClient,
  fetch: ((request = {}) =>
    Effect.flatMap(id, (experiment_id) =>
      auth.authorize(braintrust.fetchExperimentEvents({ ...request, experiment_id })),
    )) satisfies FetchExperimentEventsClient,
  feedback: ((request) =>
    Effect.flatMap(id, (experiment_id) =>
      auth.authorize(braintrust.createExperimentFeedback({ ...request, experiment_id })),
    )) satisfies ExperimentFeedbackClient,
  summarize: ((request = {}) =>
    Effect.flatMap(id, (experiment_id) =>
      auth.authorize(braintrust.summarizeExperiment({ ...request, experiment_id })),
    )) satisfies SummarizeExperimentClient,
});
