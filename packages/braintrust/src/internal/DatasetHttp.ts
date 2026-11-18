/**
 * Shared scaffolding for the bindings on the dataset: the grants, and the
 * client methods each `<Op>Http.ts` and `Read`/`Write`/`ReadWrite` layer
 * picks from. Lives in `internal/`, so the published package doesn't expose it.
 */
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Effect from "effect/Effect";
import type { BraintrustAuth, Grant } from "../BraintrustBindings.ts";
import type { Dataset } from "../Dataset.ts";
import type { DatasetFeedbackClient } from "../DatasetFeedback.ts";
import type { FetchDatasetEventsClient } from "../FetchDatasetEvents.ts";
import type { InsertDatasetEventsClient } from "../InsertDatasetEvents.ts";
import type { PreviewDatasetRestoreClient } from "../PreviewDatasetRestore.ts";
import type { RestoreDatasetClient } from "../RestoreDataset.ts";
import type { SummarizeDatasetClient } from "../SummarizeDataset.ts";

export const datasetId = (dataset: Dataset) => dataset.datasetId;

export const DATASET_READ: Grant = { objectType: "dataset", permission: "read" };
export const DATASET_UPDATE: Grant = { objectType: "dataset", permission: "update" };
export const DATASET_DELETE: Grant = { objectType: "dataset", permission: "delete" };

/** Every client method on the dataset, each sending the bound id. */
export const datasetClients = (auth: BraintrustAuth, id: Effect.Effect<string>) => ({
  insert: ((request) =>
    Effect.flatMap(id, (dataset_id) =>
      auth.authorize(braintrust.insertDatasetEvents({ ...request, dataset_id })),
    )) satisfies InsertDatasetEventsClient,
  fetch: ((request = {}) =>
    Effect.flatMap(id, (dataset_id) =>
      auth.authorize(braintrust.fetchDatasetEvents({ ...request, dataset_id })),
    )) satisfies FetchDatasetEventsClient,
  feedback: ((request) =>
    Effect.flatMap(id, (dataset_id) =>
      auth.authorize(braintrust.createDatasetFeedback({ ...request, dataset_id })),
    )) satisfies DatasetFeedbackClient,
  summarize: ((request = {}) =>
    Effect.flatMap(id, (dataset_id) =>
      auth.authorize(braintrust.summarizeDataset({ ...request, dataset_id })),
    )) satisfies SummarizeDatasetClient,
  previewRestore: ((request) =>
    Effect.flatMap(id, (dataset_id) =>
      auth.authorize(braintrust.previewDatasetRestore({ ...request, dataset_id })),
    )) satisfies PreviewDatasetRestoreClient,
  restore: ((request) =>
    Effect.flatMap(id, (dataset_id) =>
      auth.authorize(braintrust.restoreDataset({ ...request, dataset_id })),
    )) satisfies RestoreDatasetClient,
});
