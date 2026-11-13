import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { braintrustName, isGeneratedName, unlessDeleted } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

/**
 * Project-wide settings Alchemy manages. Settings set in the Braintrust UI
 * that aren't listed here (span field order, alert destinations, user and
 * session id fields, remote eval sources) are kept as they are.
 */
export interface ProjectSettings {
  /**
   * The key used to join two experiments when comparing them.
   * @default "input"
   */
  comparisonKey?: string;
  /** Id of the experiment to use as the default baseline for comparisons. */
  baselineExperimentId?: string;
  /**
   * Disable real-time queries for this project. This can improve query
   * performance for high-volume logs.
   * @default false
   */
  disableRealtimeQueries?: boolean;
  /**
   * Hide peer review scores, comments and aggregate results from reviewers
   * without project update permission until they submit their own review.
   * @default false
   */
  blindReviews?: boolean;
  /**
   * Complete a review automatically once every assigned reviewer has filled
   * all human review scores visible to them.
   * @default false
   */
  requireAllHumanReviewScores?: boolean;
}

export interface ProjectProps {
  /**
   * Project name, unique within the organization. If omitted, a unique
   * name is generated from the stack, stage and logical ID. Renaming a
   * project updates it in place; its id, logs, experiments and datasets
   * stay.
   */
  name?: string;
  /** Textual description of the project. Removing it clears the description. */
  description?: string;
  /**
   * Project settings. Only the settings listed in {@link ProjectSettings}
   * are managed; removing one resets it to Braintrust's default.
   */
  settings?: ProjectSettings;
  /**
   * Ids of the project groups the project is in, e.g.
   * `projectGroup.projectGroupId`. Once set, the project is removed from
   * any group not listed. Left unset, memberships are not managed.
   */
  projectGroupIds?: string[];
}

export interface ProjectAttributes {
  /** Unique identifier of the project. */
  projectId: string;
  /** Project name. */
  name: string;
  /** Id of the organization the project belongs to. */
  orgId: string;
  /** Textual description of the project. */
  description: string | undefined;
  /** When the project was created (ISO 8601). */
  created: string | undefined;
}

export type Project = Resource<
  "Braintrust.Project",
  ProjectProps,
  ProjectAttributes,
  never,
  Providers,
  ProjectLookup
>;

/**
 * Props for {@link Project.lookup}: find a project this stack doesn't
 * manage by its name, in the credentialed organization.
 */
export interface ProjectLookup {
  /** Project name. */
  name: string;
}

/**
 * A Braintrust project. A project holds the logs, experiments, datasets,
 * prompts and functions of one AI feature or application. See
 * [Projects](https://www.braintrust.dev/docs/guides/projects).
 *
 * Projects carry no tags, so Alchemy recognizes its own by name: a project
 * found under an explicit `name` with no prior state is refused unless
 * adopted (`adopt(true)` or `--adopt`).
 *
 * :::caution
 * Deleting a project deletes everything in it: logs, experiments, datasets,
 * prompts and functions.
 * :::
 *
 * ### Creating a Project
 * **Example:** Project with a generated name
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {
 *   description: "Evals and logs for the support bot",
 * });
 * ```
 *
 * **Example:** Project with an explicit name
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {
 *   name: "support-bot",
 * });
 * ```
 *
 * ### Configuring settings
 * **Example:** Compare experiments on a metadata field
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {
 *   settings: {
 *     comparisonKey: "metadata.case_id",
 *     blindReviews: true,
 *   },
 * });
 * ```
 *
 * ### Adding datasets and experiments
 * **Example:** A dataset and an experiment in the project
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
 * ### Grouping projects
 * **Example:** Put the project in a project group
 * ```typescript
 * const team = yield* Braintrust.ProjectGroup("SupportTeam", {});
 * const project = yield* Braintrust.Project("Support", {
 *   projectGroupIds: [team.projectGroupId],
 * });
 * ```
 *
 * ### Looking up an existing project
 * `Project.lookup` references a project Alchemy doesn't manage. It is read
 * during plan and deploy, never created, updated or deleted.
 *
 * **Example:** Add a dataset to an existing project
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const dataset = yield* Braintrust.Dataset("Tickets", {
 *   projectId: project.projectId,
 * });
 * ```
 *
 * ### Adopting an existing project
 * **Example:** Take over a project created in the Braintrust UI
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {
 *   name: "support-bot",
 * }).pipe(adopt(true));
 * ```
 *
 * @resource
 * @product Project
 */
export const Project = Resource<Project>("Braintrust.Project");

/** The managed settings as Braintrust names them; `undefined` means its default. */
const settingsOf = (settings: ProjectSettings | undefined) => ({
  comparison_key: settings?.comparisonKey,
  baseline_experiment_id: settings?.baselineExperimentId,
  disable_realtime_queries: settings?.disableRealtimeQueries,
  blind_reviews: settings?.blindReviews,
  require_all_human_review_scores: settings?.requireAllHumanReviewScores,
});

const toAttributes = (project: braintrust.Project): ProjectAttributes => ({
  projectId: project.id,
  name: project.name,
  orgId: project.org_id,
  description: project.description ?? undefined,
  created: project.created ?? undefined,
});

const getById = (projectId: string) =>
  braintrust.getProject({ project_id: projectId }).pipe(
    Effect.map(unlessDeleted),
    Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined),
  );

const findByName = (name: string) =>
  braintrust.listProjects.items({ project_name: name }).pipe(
    Stream.filter((project) => project.name === name && !project.deleted_at),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      return {
        stables: ["projectId", "orgId"],
        lookup: Effect.fn(function* ({ name }) {
          const project = yield* findByName(name);
          return project ? toAttributes(project) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const project = yield* getById(output.projectId);
            return project ? toAttributes(project) : undefined;
          }
          const project = yield* findByName(yield* braintrustName(id, olds?.name));
          if (!project) return undefined;
          const attrs = toAttributes(project);
          // A generated name carries this instance's suffix, so it is ours.
          return olds?.name === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "projectId");
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const name = yield* braintrustName(id, news.name);

          // Observe — by id once we have one (it survives renames), else by name.
          let project =
            (output ? yield* getById(output.projectId) : undefined) ?? (yield* findByName(name));

          // Ensure — POST returns the existing project of the same name
          // unchanged, so a concurrent create converges on one project.
          if (!project) {
            yield* session.note(`Creating project ${name}...`);
            project = yield* braintrust.createProject({
              name,
              description: news.description,
            });
          }

          // Sync — PATCH only the fields that differ from what is deployed.
          const update: Omit<braintrust.UpdateProjectRequest, "project_id"> = {};
          if (project.name !== name) update.name = name;
          if ((project.description ?? undefined) !== news.description) {
            update.description = news.description ?? null;
          }
          // A settings PATCH replaces every setting, so unmanaged ones are
          // sent back as observed. Untouched until the props first set them.
          if (news.settings !== undefined || olds?.settings !== undefined) {
            const managed = settingsOf(news.settings);
            const observed = project.settings ?? {};
            const changed = (Object.keys(managed) as (keyof typeof managed)[]).some(
              (key) => (observed[key] ?? undefined) !== managed[key],
            );
            if (changed) update.settings = { ...observed, ...managed };
          }
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating project ${name}...`);
            project = yield* braintrust.updateProject({ project_id: project.id, ...update });
          }

          // Project groups — membership is stored on each group, so observe
          // every group the project is in. Untouched until the props first
          // set it, so memberships made in the UI survive.
          if (news.projectGroupIds !== undefined || olds?.projectGroupIds !== undefined) {
            const projectId = project.id;
            const desired = news.projectGroupIds ?? [];
            const groups = yield* Stream.runCollect(braintrust.listProjectGroups.items({}));
            const observed = groups
              .filter((group) => !group.deleted_at && group.member_projects.includes(projectId))
              .map((group) => group.id);
            for (const groupId of desired.filter((g) => !observed.includes(g))) {
              yield* session.note(`Adding project ${name} to project group ${groupId}...`);
              yield* braintrust.updateProjectGroup({
                project_group_id: groupId,
                add_member_projects: [projectId],
              });
            }
            for (const groupId of observed.filter((g) => !desired.includes(g))) {
              yield* session.note(`Removing project ${name} from project group ${groupId}...`);
              yield* braintrust
                .updateProjectGroup({
                  project_group_id: groupId,
                  remove_member_projects: [projectId],
                })
                .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
            }
          }

          return toAttributes(project);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteProject({ project_id: output.projectId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const projects = yield* Stream.runCollect(braintrust.listProjects.items({}));
          return projects
            .filter((project) => !project.deleted_at && isGeneratedName(project.name))
            .map(toAttributes);
        }),
      };
    }),
  );
