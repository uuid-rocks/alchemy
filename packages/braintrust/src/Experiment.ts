import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  braintrustName,
  confirmDeleted,
  isGeneratedName,
  sameName,
  unlessDeleted,
} from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface ExperimentProps {
  /**
   * Id of the project the experiment belongs to, e.g. `project.projectId`.
   * Changing it replaces the experiment, and its logged results are deleted
   * with the old one.
   */
  projectId: string;
  /**
   * Experiment name, unique within the project. If omitted, a unique name
   * is generated from the stack, stage and logical ID. Renaming updates the
   * experiment in place.
   */
  name?: string;
  /** Textual description of the experiment. Removing it clears the description. */
  description?: string;
  /**
   * Whether anybody, inside or outside the organization, can view the
   * experiment.
   * @default false
   */
  public?: boolean;
  /** Tags for the experiment. Removing them clears the tags. */
  tags?: string[];
  /**
   * User-controlled metadata. Braintrust merges metadata key by key, so a
   * key removed here is kept on the experiment with a `null` value.
   */
  metadata?: Record<string, unknown>;
  /** Id of the experiment to compare against by default, e.g. a baseline's `experimentId`. */
  baseExperimentId?: string;
  /**
   * Id of the dataset the experiment runs against, e.g. `dataset.datasetId`.
   * It can be changed in place, but Braintrust can't unlink a dataset, so
   * removing it replaces the experiment.
   */
  datasetId?: string;
  /**
   * Version of the linked dataset the experiment ran against (the
   * dataset's `_xact_id` at the time), so the run can be reproduced after
   * the dataset changes. Removing it clears it.
   */
  datasetVersion?: string;
  /**
   * Id of the saved parameters the experiment ran with, e.g.
   * `Braintrust.Function.lookup(...).functionId` for parameters pushed with
   * `braintrust push`. It can be changed in place, but Braintrust
   * can't unlink parameters, so removing it replaces the experiment.
   */
  parametersId?: string;
  /**
   * Version of the saved parameters the experiment ran with, e.g.
   * `parameters.version`. Removing it clears it.
   */
  parametersVersion?: string;
  /**
   * The state of the repository the experiment ran from: `commit`,
   * `branch`, `tag`, `dirty`, author, commit message and time, and
   * `git_diff`. Braintrust merges it key by key, so a key removed here is
   * kept on the experiment with a `null` value.
   */
  repoInfo?: braintrust.CreateEvalRequestRepoInfo;
}

export interface ExperimentAttributes {
  /** Unique identifier of the experiment. */
  experimentId: string;
  /** Id of the project the experiment belongs to. */
  projectId: string;
  /** Experiment name. */
  name: string;
  /** Textual description of the experiment. */
  description: string | undefined;
  /** Whether the experiment is public. */
  public: boolean;
  /** Tags for the experiment. */
  tags: string[];
  /** User-controlled metadata, without keys whose value is `null`. */
  metadata: Record<string, unknown> | undefined;
  /** Id of the default base experiment. */
  baseExperimentId: string | undefined;
  /** Id of the linked dataset. */
  datasetId: string | undefined;
  /** Version of the linked dataset the experiment ran against. */
  datasetVersion: string | undefined;
  /** Id of the linked saved parameters. */
  parametersId: string | undefined;
  /** Version of the linked saved parameters. */
  parametersVersion: string | undefined;
  /** The state of the repository the experiment ran from, without keys whose value is `null`. */
  repoInfo: braintrust.CreateEvalRequestRepoInfo | undefined;
  /** When the experiment was created (ISO 8601). */
  created: string | undefined;
}

export type Experiment = Resource<
  "Braintrust.Experiment",
  ExperimentProps,
  ExperimentAttributes,
  never,
  Providers,
  ExperimentLookup
>;

/**
 * Props for {@link Experiment.lookup}: find an experiment this stack
 * doesn't manage by its project and name.
 */
export interface ExperimentLookup {
  /** Id of the project the experiment belongs to. */
  projectId: string;
  /** Experiment name. */
  name: string;
}

/**
 * A Braintrust experiment: one run of an eval, whose logged results and
 * scores are compared against other experiments in the project. See
 * [Evals](https://www.braintrust.dev/docs/guides/evals).
 *
 * Evals usually create their experiments themselves through the Braintrust
 * SDK. Declare one with Alchemy when it should outlive a single run, such
 * as a pinned baseline other experiments compare against.
 *
 * :::caution
 * Changing `projectId`, or removing `datasetId` or `parametersId`, replaces
 * the experiment.
 * Its logged results are deleted with the old one.
 * :::
 *
 * ### Creating an Experiment
 * **Example:** Experiment in a project
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const experiment = yield* Braintrust.Experiment("Baseline", {
 *   projectId: project.projectId,
 *   description: "Pinned baseline for the support bot",
 * });
 * ```
 *
 * **Example:** Experiment linked to a dataset, with tags and metadata
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const dataset = yield* Braintrust.Dataset("Tickets", {
 *   projectId: project.projectId,
 * });
 * const experiment = yield* Braintrust.Experiment("Baseline", {
 *   projectId: project.projectId,
 *   datasetId: dataset.datasetId,
 *   tags: ["baseline"],
 *   metadata: { model: "gpt-4o-mini" },
 * });
 * ```
 *
 * ### Pinning what the experiment ran against
 * **Example:** Record the dataset version, saved parameters and commit
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const dataset = yield* Braintrust.Dataset("Tickets", {
 *   projectId: project.projectId,
 * });
 * // Saved parameters are pushed with `braintrust push` or made in the UI.
 * const parameters = Braintrust.Function.lookup({
 *   projectId: project.projectId,
 *   slug: "support-parameters",
 * });
 * const baseline = yield* Braintrust.Experiment("Baseline", {
 *   projectId: project.projectId,
 *   datasetId: dataset.datasetId,
 *   datasetVersion: "1000198228304465130",
 *   parametersId: parameters.functionId,
 *   parametersVersion: parameters.version,
 *   repoInfo: { commit: "4f2a9c1", branch: "main", dirty: false },
 * });
 * ```
 *
 * ### Comparing against a baseline
 * **Example:** An experiment that compares against a pinned baseline
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const baseline = yield* Braintrust.Experiment("Baseline", {
 *   projectId: project.projectId,
 * });
 * const candidate = yield* Braintrust.Experiment("Candidate", {
 *   projectId: project.projectId,
 *   baseExperimentId: baseline.experimentId,
 * });
 * ```
 *
 * ### Sharing an experiment
 * **Example:** Make an experiment public
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const experiment = yield* Braintrust.Experiment("Showcase", {
 *   projectId: project.projectId,
 *   public: true,
 * });
 * ```
 *
 * ### Looking up an existing experiment
 * **Example:** Reference an experiment an eval created
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const experiment = Braintrust.Experiment.lookup({
 *   projectId: project.projectId,
 *   name: "main-1700000000",
 * });
 * ```
 *
 * @resource
 * @product Experiment
 */
export const Experiment = Resource<Experiment>("Braintrust.Experiment");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Metadata or repo info without the keys a merge patch has nulled. */
const withoutNulls = (metadata: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => [key, isRecord(value) ? withoutNulls(value) : value]),
  );

/**
 * The PATCH body that turns observed metadata or repo info into desired.
 * Braintrust deep-merges both and stores a key sent as `null`, so
 * unchanged keys are left out and removed keys are nulled.
 */
const metadataPatch = (
  observed: Record<string, unknown>,
  desired: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(desired)) {
    const current = observed[key];
    if (isRecord(value) && isRecord(current)) {
      const nested = metadataPatch(current, value);
      if (nested) patch[key] = nested;
    } else if (!deepEqual(current, value)) {
      patch[key] = value;
    }
  }
  for (const [key, value] of Object.entries(observed)) {
    if (!(key in desired) && value !== null) patch[key] = null;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
};

const toAttributes = (experiment: braintrust.Experiment): ExperimentAttributes => {
  const metadata = withoutNulls(experiment.metadata ?? {});
  const repoInfo = withoutNulls({ ...experiment.repo_info });
  return {
    experimentId: experiment.id,
    projectId: experiment.project_id,
    name: experiment.name,
    description: experiment.description || undefined,
    public: experiment.public,
    tags: [...(experiment.tags ?? [])],
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    baseExperimentId: experiment.base_exp_id ?? undefined,
    datasetId: experiment.dataset_id ?? undefined,
    datasetVersion: experiment.dataset_version || undefined,
    parametersId: experiment.parameters_id ?? undefined,
    parametersVersion: experiment.parameters_version || undefined,
    repoInfo:
      Object.keys(repoInfo).length > 0
        ? (repoInfo as braintrust.CreateEvalRequestRepoInfo)
        : undefined,
    created: experiment.created ?? undefined,
  };
};

const getById = (experimentId: string) =>
  braintrust.getExperiment({ experiment_id: experimentId }).pipe(
    Effect.map(unlessDeleted),
    Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined),
  );

const findByName = (projectId: string, name: string) =>
  braintrust.listExperiments.items({ project_id: projectId, experiment_name: name }).pipe(
    Stream.filter(
      (experiment) =>
        experiment.project_id === projectId && experiment.name === name && !experiment.deleted_at,
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const ExperimentProvider = () =>
  Provider.effect(
    Experiment,
    Effect.gen(function* () {
      return {
        stables: ["experimentId", "projectId"],
        diff: Effect.fn(function* ({ news, olds, output }) {
          if ("projectId" in news) {
            // An id that resolves only at apply may name a new parent or the
            // same one, and apply doesn't diff again, so the move is planned as
            // a replace now.
            if (!isResolved(news.projectId)) {
              return { action: "replace", deleteFirst: sameName(news.name, olds.name) } as const;
            }
            // Compared before the other props resolve: with one unresolved,
            // the engine plans an update, which would create the object in the
            // new parent and leave the old one behind.
            if (news.projectId !== olds.projectId) return { action: "replace" } as const;
            // An adoption's `olds` are the new props; `output` is what it found.
            // Checked before the other props resolve, for the same reason.
            const unlinked = (key: "datasetId" | "parametersId") =>
              (output?.[key] ?? olds[key]) !== undefined && news[key] === undefined;
            if (unlinked("datasetId") || unlinked("parametersId")) {
              // A replacement under the same name would find the old
              // experiment again, so it goes first.
              return {
                action: "replace",
                deleteFirst: sameName(news.name, olds.name),
              } as const;
            }
          }
        }),
        lookup: Effect.fn(function* ({ projectId, name }) {
          const experiment = yield* findByName(projectId, name);
          return experiment ? toAttributes(experiment) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const experiment = yield* getById(output.experimentId);
            return experiment ? toAttributes(experiment) : undefined;
          }
          const name = yield* braintrustName(id, olds.name);
          const experiment = yield* findByName(olds.projectId, name);
          if (!experiment) return undefined;
          const attrs = toAttributes(experiment);
          // A generated name carries this instance's suffix, so it is ours.
          return olds.name === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "experimentId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* braintrustName(id, news.name);

          // Observe — by id once we have one (it survives renames), else by name.
          const cached = output ? yield* getById(output.experimentId) : undefined;
          let experiment =
            (cached?.project_id === news.projectId ? cached : undefined) ??
            (yield* findByName(news.projectId, name));

          // Ensure — POST returns the existing experiment of the same name
          // unchanged (`ensure_new` is never sent), so a concurrent create
          // converges on one experiment.
          if (!experiment) {
            yield* session.note(`Creating experiment ${name}...`);
            experiment = yield* braintrust.createExperiment({
              project_id: news.projectId,
              name,
              description: news.description,
              public: news.public,
              tags: news.tags,
              metadata: news.metadata,
              base_exp_id: news.baseExperimentId,
              dataset_id: news.datasetId,
              dataset_version: news.datasetVersion,
              parameters_id: news.parametersId,
              parameters_version: news.parametersVersion,
              repo_info: news.repoInfo,
            });
          }

          // Sync — PATCH only the fields that differ from what is deployed.
          // Experiments ignore `null` for most fields: an empty string
          // clears the description and versions, and `[]` the tags.
          const update: Omit<braintrust.UpdateExperimentRequest, "experiment_id"> = {};
          if (experiment.name !== name) update.name = name;
          if ((experiment.description || undefined) !== (news.description || undefined)) {
            update.description = news.description ?? "";
          }
          if (experiment.public !== (news.public ?? false)) update.public = news.public ?? false;
          if (!deepEqual(experiment.tags ?? [], news.tags ?? [])) update.tags = news.tags ?? [];
          const metadata = metadataPatch(experiment.metadata ?? {}, news.metadata ?? {});
          if (metadata) update.metadata = metadata;
          if ((experiment.base_exp_id ?? undefined) !== news.baseExperimentId) {
            update.base_exp_id = news.baseExperimentId ?? null;
          }
          if (news.datasetId !== undefined && experiment.dataset_id !== news.datasetId) {
            update.dataset_id = news.datasetId;
          }
          if ((experiment.dataset_version || undefined) !== (news.datasetVersion || undefined)) {
            update.dataset_version = news.datasetVersion ?? "";
          }
          if (news.parametersId !== undefined && experiment.parameters_id !== news.parametersId) {
            update.parameters_id = news.parametersId;
          }
          if (
            (experiment.parameters_version || undefined) !== (news.parametersVersion || undefined)
          ) {
            update.parameters_version = news.parametersVersion ?? "";
          }
          // Repo info merges like metadata.
          const repoInfo = metadataPatch({ ...experiment.repo_info }, { ...news.repoInfo });
          if (repoInfo) update.repo_info = repoInfo as braintrust.CreateEvalRequestRepoInfo;
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating experiment ${name}...`);
            experiment = yield* braintrust.updateExperiment({
              experiment_id: experiment.id,
              ...update,
            });
          }

          return toAttributes(experiment);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteExperiment({ experiment_id: output.experimentId })
            .pipe(
              Effect.catchTag("NotFoundOrForbidden", () =>
                confirmDeleted("experiment", output.experimentId, getById(output.experimentId)),
              ),
            );
        }),
        list: Effect.fn(function* () {
          const experiments = yield* Stream.runCollect(braintrust.listExperiments.items({}));
          return experiments
            .filter((experiment) => !experiment.deleted_at && isGeneratedName(experiment.name))
            .map(toAttributes);
        }),
      };
    }),
  );
