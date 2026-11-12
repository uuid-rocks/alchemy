import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { braintrustName, isGeneratedName, unlessDeleted } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface DatasetProps {
  /**
   * Id of the project the dataset belongs to, e.g. `project.projectId`.
   * Changing it replaces the dataset, and the records in the old one are
   * deleted with it.
   */
  projectId: string;
  /**
   * Dataset name, unique within the project. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Renaming updates the
   * dataset in place; its URL slug keeps the original name.
   */
  name?: string;
  /** Textual description of the dataset. Removing it clears the description. */
  description?: string;
  /** Tags for the dataset. Removing them clears the tags. */
  tags?: string[];
  /**
   * User-controlled metadata. Replaced as a whole on every change; removing
   * it clears the metadata.
   */
  metadata?: Record<string, unknown>;
}

export interface DatasetAttributes {
  /** Unique identifier of the dataset. */
  datasetId: string;
  /** Id of the project the dataset belongs to. */
  projectId: string;
  /** Dataset name. */
  name: string;
  /** Textual description of the dataset. */
  description: string | undefined;
  /** Tags for the dataset. */
  tags: string[];
  /** User-controlled metadata. */
  metadata: Record<string, unknown> | undefined;
  /** URL slug of the dataset, from the name it was created with. */
  urlSlug: string;
  /** When the dataset was created (ISO 8601). */
  created: string | undefined;
}

export type Dataset = Resource<
  "Braintrust.Dataset",
  DatasetProps,
  DatasetAttributes,
  never,
  Providers,
  DatasetLookup
>;

/**
 * Props for {@link Dataset.lookup}: find a dataset this stack doesn't
 * manage by its project and name.
 */
export interface DatasetLookup {
  /** Id of the project the dataset belongs to. */
  projectId: string;
  /** Dataset name. */
  name: string;
}

/**
 * A Braintrust dataset: versioned records (input, expected output,
 * metadata) that evals run against. Alchemy manages the dataset itself;
 * records are written through the Braintrust SDK or the API.
 * @see https://www.braintrust.dev/docs/guides/datasets
 *
 * Datasets carry no tags Alchemy can use for ownership, so a dataset found
 * under an explicit `name` with no prior state is refused unless adopted.
 *
 * :::caution
 * Changing `projectId` replaces the dataset. The records in the old dataset
 * are deleted with it.
 * :::
 *
 * ### Creating a Dataset
 * **Example:** Dataset in a project
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const dataset = yield* Braintrust.Dataset("Tickets", {
 *   projectId: project.projectId,
 *   description: "Golden support tickets",
 * });
 * ```
 *
 * **Example:** Dataset with an explicit name, tags and metadata
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const dataset = yield* Braintrust.Dataset("Tickets", {
 *   projectId: project.projectId,
 *   name: "golden-tickets",
 *   tags: ["golden", "support"],
 *   metadata: { owner: "support-team" },
 * });
 * ```
 *
 * ### Running experiments against a dataset
 * **Example:** Link an experiment to the dataset
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const dataset = yield* Braintrust.Dataset("Tickets", {
 *   projectId: project.projectId,
 * });
 * const experiment = yield* Braintrust.Experiment("Baseline", {
 *   projectId: project.projectId,
 *   datasetId: dataset.datasetId,
 * });
 * ```
 *
 * ### Looking up an existing dataset
 * **Example:** Reference a dataset made in the Braintrust UI
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const dataset = Braintrust.Dataset.lookup({
 *   projectId: project.projectId,
 *   name: "Golden tickets",
 * });
 * ```
 *
 * @resource
 * @product Dataset
 */
export const Dataset = Resource<Dataset>("Braintrust.Dataset");

const toAttributes = (dataset: braintrust.Dataset): DatasetAttributes => ({
  datasetId: dataset.id,
  projectId: dataset.project_id,
  name: dataset.name,
  description: dataset.description ?? undefined,
  tags: [...(dataset.tags ?? [])],
  metadata: dataset.metadata ?? undefined,
  urlSlug: dataset.url_slug,
  created: dataset.created ?? undefined,
});

const getById = (datasetId: string) =>
  braintrust.getDataset({ dataset_id: datasetId }).pipe(
    Effect.map(unlessDeleted),
    Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined),
  );

const findByName = (projectId: string, name: string) =>
  braintrust.listDatasets.items({ project_id: projectId, dataset_name: name }).pipe(
    Stream.filter(
      (dataset) => dataset.project_id === projectId && dataset.name === name && !dataset.deleted_at,
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const DatasetProvider = () =>
  Provider.effect(
    Dataset,
    Effect.gen(function* () {
      return {
        stables: ["datasetId", "projectId", "urlSlug"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.projectId !== olds.projectId) return { action: "replace" } as const;
        }),
        lookup: Effect.fn(function* ({ projectId, name }) {
          const dataset = yield* findByName(projectId, name);
          return dataset ? toAttributes(dataset) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const dataset = yield* getById(output.datasetId);
            return dataset ? toAttributes(dataset) : undefined;
          }
          const dataset = yield* findByName(olds.projectId, yield* braintrustName(id, olds.name));
          if (!dataset) return undefined;
          const attrs = toAttributes(dataset);
          // A generated name carries this instance's suffix, so it is ours.
          return olds.name === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "datasetId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* braintrustName(id, news.name);

          // Observe — by id once we have one (it survives renames), else by name.
          const cached = output ? yield* getById(output.datasetId) : undefined;
          let dataset =
            (cached?.project_id === news.projectId ? cached : undefined) ??
            (yield* findByName(news.projectId, name));

          // Ensure — POST returns the existing dataset of the same name
          // unchanged, so a concurrent create converges on one dataset.
          if (!dataset) {
            yield* session.note(`Creating dataset ${name}...`);
            dataset = yield* braintrust.createDataset({
              project_id: news.projectId,
              name,
              description: news.description,
              tags: news.tags,
              metadata: news.metadata,
            });
          }

          // Sync — PATCH only the fields that differ from what is deployed.
          // `null` clears a field, `[]` clears the tags, and metadata is
          // replaced as a whole.
          const update: Omit<braintrust.UpdateDatasetRequest, "dataset_id"> = {};
          if (dataset.name !== name) update.name = name;
          if ((dataset.description ?? undefined) !== news.description) {
            update.description = news.description ?? null;
          }
          if (!deepEqual(dataset.tags ?? [], news.tags ?? [])) update.tags = news.tags ?? [];
          if (!deepEqual(dataset.metadata ?? undefined, news.metadata)) {
            update.metadata = news.metadata ?? null;
          }
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating dataset ${name}...`);
            dataset = yield* braintrust.updateDataset({ dataset_id: dataset.id, ...update });
          }

          return toAttributes(dataset);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteDataset({ dataset_id: output.datasetId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const datasets = yield* Stream.runCollect(braintrust.listDatasets.items({}));
          return datasets
            .filter((dataset) => !dataset.deleted_at && isGeneratedName(dataset.name))
            .map(toAttributes);
        }),
      };
    }),
  );
