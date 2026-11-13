import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { braintrustName, isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface ProjectScoreProps {
  /**
   * Id of the project the score belongs to, e.g. `project.projectId`.
   * Changing it replaces the score.
   */
  projectId: string;
  /**
   * Score name, unique within the project. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Renaming updates the
   * score in place.
   */
  name?: string;
  /**
   * How the score is entered or computed: `slider` (0 to 1), `categorical`
   * (one of `categories`), `free-form`, `weighted`, `minimum` or `maximum`
   * (combine other scores), or `online` (scorers run on incoming logs).
   */
  scoreType: braintrust.ProjectScoreType;
  /** Textual description of the score. Removing it clears the description. */
  description?: string;
  /**
   * For `categorical` scores, the list of `{ name, value }` options; for
   * `weighted` scores, a map of score name to weight; for `minimum` and
   * `maximum` scores, the names of the scores to combine. Removing it
   * clears the categories.
   */
  categories?: braintrust.ProjectScoreCategories;
  /**
   * Score configuration: `multi_select`, `destination`, `visibility`,
   * `online` scoring, `condition` and `object_types`. Replaced as a whole on
   * every change; removing it clears the configuration.
   */
  config?: braintrust.ProjectScoreConfig;
}

export interface ProjectScoreAttributes {
  /** Unique identifier of the project score. */
  projectScoreId: string;
  /** Id of the project the score belongs to. */
  projectId: string;
  /** Score name. */
  name: string;
  /** How the score is entered or computed. */
  scoreType: braintrust.ProjectScoreType;
  /** Textual description of the score. */
  description: string | undefined;
  /** Categories, weights or combined scores, by score type. */
  categories: braintrust.ProjectScoreCategories | undefined;
  /** Score configuration. */
  config: braintrust.ProjectScoreConfig | undefined;
  /** When the score was created (ISO 8601). */
  created: string | undefined;
}

export type ProjectScore = Resource<
  "Braintrust.ProjectScore",
  ProjectScoreProps,
  ProjectScoreAttributes,
  never,
  Providers,
  ProjectScoreLookup
>;

/**
 * Props for {@link ProjectScore.lookup}: find a score this stack doesn't
 * manage by its project and name.
 */
export interface ProjectScoreLookup {
  /** Id of the project the score belongs to. */
  projectId: string;
  /** Score name. */
  name: string;
}

/**
 * A Braintrust project score: a score reviewers fill in on logs,
 * experiments and datasets (a slider, categories or free-form text), or one
 * computed from other scores. See
 * [Human review](https://www.braintrust.dev/docs/guides/human-review).
 *
 * Project scores carry no labels Alchemy can use for ownership, so a score
 * found under an explicit `name` with no prior state is refused unless
 * adopted.
 *
 * :::caution
 * Changing `projectId` replaces the score.
 * :::
 *
 * ### Creating a Project Score
 * **Example:** Slider score for human review
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const helpfulness = yield* Braintrust.ProjectScore("Helpfulness", {
 *   projectId: project.projectId,
 *   name: "Helpfulness",
 *   scoreType: "slider",
 * });
 * ```
 *
 * **Example:** Categorical score written to the expected output
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const verdict = yield* Braintrust.ProjectScore("Verdict", {
 *   projectId: project.projectId,
 *   scoreType: "categorical",
 *   categories: [
 *     { name: "correct", value: 1 },
 *     { name: "partially correct", value: 0.5 },
 *     { name: "wrong", value: 0 },
 *   ],
 *   config: { destination: "expected" },
 * });
 * ```
 *
 * ### Looking up an existing score
 * **Example:** Reference a score made in the Braintrust UI
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const score = Braintrust.ProjectScore.lookup({
 *   projectId: project.projectId,
 *   name: "Helpfulness",
 * });
 * ```
 *
 * @resource
 * @product Project Score
 */
export const ProjectScore = Resource<ProjectScore>("Braintrust.ProjectScore");

const isEmpty = (value: object | null | undefined) =>
  value == null || Object.keys(value).length === 0;

const toAttributes = (score: braintrust.ProjectScore): ProjectScoreAttributes => ({
  projectScoreId: score.id,
  projectId: score.project_id,
  name: score.name,
  scoreType: score.score_type,
  // A PATCH can't null these fields, so a cleared one reads back empty.
  description: score.description || undefined,
  categories: isEmpty(score.categories) ? undefined : (score.categories ?? undefined),
  config: isEmpty(score.config) ? undefined : (score.config ?? undefined),
  created: score.created ?? undefined,
});

const getById = (projectScoreId: string) =>
  braintrust
    .getProjectScore({ project_score_id: projectScoreId })
    .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined));

const findByName = (projectId: string, name: string) =>
  braintrust.listProjectScores.items({ project_id: projectId, project_score_name: name }).pipe(
    Stream.filter((score) => score.project_id === projectId && score.name === name),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const ProjectScoreProvider = () =>
  Provider.effect(
    ProjectScore,
    Effect.gen(function* () {
      return {
        stables: ["projectScoreId", "projectId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.projectId !== olds.projectId) return { action: "replace" } as const;
        }),
        lookup: Effect.fn(function* ({ projectId, name }) {
          const score = yield* findByName(projectId, name);
          return score ? toAttributes(score) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const score = yield* getById(output.projectScoreId);
            return score ? toAttributes(score) : undefined;
          }
          const name = yield* braintrustName(id, olds.name);
          const score = yield* findByName(olds.projectId, name);
          if (!score) return undefined;
          const attrs = toAttributes(score);
          // A generated name carries this instance's suffix, so it is ours.
          return olds.name === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "projectScoreId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* braintrustName(id, news.name);

          // Observe — by id once we have one (it survives renames), else by name.
          const cached = output ? yield* getById(output.projectScoreId) : undefined;
          let score =
            (cached?.project_id === news.projectId ? cached : undefined) ??
            (yield* findByName(news.projectId, name));

          // Ensure — POST returns the existing score of the same name
          // unchanged, so a concurrent create converges on one score.
          if (!score) {
            yield* session.note(`Creating project score ${name}...`);
            score = yield* braintrust.createProjectScore({
              project_id: news.projectId,
              name,
              score_type: news.scoreType,
              description: news.description,
              categories: news.categories,
              config: news.config,
            });
          }

          // Sync — PATCH only the fields that differ from what is deployed.
          // The API ignores `null` (and refuses it for categories): an
          // empty string clears the description, an empty list or map the
          // categories, and `{}` the config, which is replaced as a whole.
          const observed = toAttributes(score);
          const update: Omit<braintrust.UpdateProjectScoreRequest, "project_score_id"> = {};
          if (observed.name !== name) update.name = name;
          if (observed.scoreType !== news.scoreType) update.score_type = news.scoreType;
          if (observed.description !== news.description) {
            update.description = news.description ?? "";
          }
          if (
            !deepEqual(observed.categories, isEmpty(news.categories) ? undefined : news.categories)
          ) {
            update.categories = news.categories ?? (Array.isArray(score.categories) ? [] : {});
          }
          if (!deepEqual(observed.config, isEmpty(news.config) ? undefined : news.config)) {
            update.config = news.config ?? {};
          }
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating project score ${name}...`);
            score = yield* braintrust.updateProjectScore({ project_score_id: score.id, ...update });
          }

          return toAttributes(score);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteProjectScore({ project_score_id: output.projectScoreId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const scores = yield* Stream.runCollect(braintrust.listProjectScores.items({}));
          return scores.filter((score) => isGeneratedName(score.name)).map(toAttributes);
        }),
      };
    }),
  );
