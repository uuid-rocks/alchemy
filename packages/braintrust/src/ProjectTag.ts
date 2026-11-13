import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { braintrustName, isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface ProjectTagProps {
  /**
   * Id of the project the tag belongs to, e.g. `project.projectId`.
   * Changing it replaces the tag.
   */
  projectId: string;
  /**
   * Tag name, unique within the project. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Renaming updates the
   * tag in place.
   */
  name?: string;
  /** Textual description of the tag. Removing it clears the description. */
  description?: string;
  /**
   * Color of the tag in the Braintrust UI, as a CSS color such as
   * `"#3b82f6"`. Removing it clears the color.
   */
  color?: string;
}

export interface ProjectTagAttributes {
  /** Unique identifier of the project tag. */
  projectTagId: string;
  /** Id of the project the tag belongs to. */
  projectId: string;
  /** Tag name. */
  name: string;
  /** Textual description of the tag. */
  description: string | undefined;
  /** Color of the tag in the Braintrust UI. */
  color: string | undefined;
  /** When the tag was created (ISO 8601). */
  created: string | undefined;
}

export type ProjectTag = Resource<
  "Braintrust.ProjectTag",
  ProjectTagProps,
  ProjectTagAttributes,
  never,
  Providers,
  ProjectTagLookup
>;

/**
 * Props for {@link ProjectTag.lookup}: find a tag this stack doesn't manage
 * by its project and name.
 */
export interface ProjectTagLookup {
  /** Id of the project the tag belongs to. */
  projectId: string;
  /** Tag name. */
  name: string;
}

/**
 * A Braintrust project tag: a named, colored label that logs, experiment
 * rows and dataset records in the project can carry. See
 * [Tags](https://www.braintrust.dev/docs/guides/logs/write#tags).
 *
 * Tags carry no labels Alchemy can use for ownership, so a tag found under
 * an explicit `name` with no prior state is refused unless adopted.
 *
 * :::caution
 * Changing `projectId` replaces the tag.
 * :::
 *
 * ### Creating a Project Tag
 * **Example:** Tag in a project
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const tag = yield* Braintrust.ProjectTag("Escalated", {
 *   projectId: project.projectId,
 *   name: "escalated",
 *   description: "Escalated to a human agent",
 *   color: "#ef4444",
 * });
 * ```
 *
 * ### Looking up an existing tag
 * **Example:** Reference a tag made in the Braintrust UI
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const tag = Braintrust.ProjectTag.lookup({
 *   projectId: project.projectId,
 *   name: "triage",
 * });
 * ```
 *
 * @resource
 * @product Project Tag
 */
export const ProjectTag = Resource<ProjectTag>("Braintrust.ProjectTag");

const toAttributes = (tag: braintrust.ProjectTag): ProjectTagAttributes => ({
  projectTagId: tag.id,
  projectId: tag.project_id,
  name: tag.name,
  // A PATCH can't null these fields, so a cleared one reads back as "".
  description: tag.description || undefined,
  color: tag.color || undefined,
  created: tag.created ?? undefined,
});

const getById = (projectTagId: string) =>
  braintrust
    .getProjectTag({ project_tag_id: projectTagId })
    .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined));

const findByName = (projectId: string, name: string) =>
  braintrust.listProjectTags.items({ project_id: projectId, project_tag_name: name }).pipe(
    Stream.filter((tag) => tag.project_id === projectId && tag.name === name),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const ProjectTagProvider = () =>
  Provider.effect(
    ProjectTag,
    Effect.gen(function* () {
      return {
        stables: ["projectTagId", "projectId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.projectId !== olds.projectId) return { action: "replace" } as const;
        }),
        lookup: Effect.fn(function* ({ projectId, name }) {
          const tag = yield* findByName(projectId, name);
          return tag ? toAttributes(tag) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const tag = yield* getById(output.projectTagId);
            return tag ? toAttributes(tag) : undefined;
          }
          const name = yield* braintrustName(id, olds.name);
          const tag = yield* findByName(olds.projectId, name);
          if (!tag) return undefined;
          const attrs = toAttributes(tag);
          // A generated name carries this instance's suffix, so it is ours.
          return olds.name === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "projectTagId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* braintrustName(id, news.name);

          // Observe — by id once we have one (it survives renames), else by name.
          const cached = output ? yield* getById(output.projectTagId) : undefined;
          let tag =
            (cached?.project_id === news.projectId ? cached : undefined) ??
            (yield* findByName(news.projectId, name));

          // Ensure — POST returns the existing tag of the same name
          // unchanged, so a concurrent create converges on one tag.
          if (!tag) {
            yield* session.note(`Creating project tag ${name}...`);
            tag = yield* braintrust.createProjectTag({
              project_id: news.projectId,
              name,
              description: news.description,
              color: news.color,
            });
          }

          // Sync — PATCH only the fields that differ from what is deployed.
          // The API ignores `null`; an empty string clears a field.
          const update: Omit<braintrust.UpdateProjectTagRequest, "project_tag_id"> = {};
          if (tag.name !== name) update.name = name;
          if ((tag.description || undefined) !== news.description) {
            update.description = news.description ?? "";
          }
          if ((tag.color || undefined) !== news.color) update.color = news.color ?? "";
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating project tag ${name}...`);
            tag = yield* braintrust.updateProjectTag({ project_tag_id: tag.id, ...update });
          }

          return toAttributes(tag);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteProjectTag({ project_tag_id: output.projectTagId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const tags = yield* Stream.runCollect(braintrust.listProjectTags.items({}));
          return tags.filter((tag) => isGeneratedName(tag.name)).map(toAttributes);
        }),
      };
    }),
  );
