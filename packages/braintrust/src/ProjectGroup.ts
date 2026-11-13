import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { braintrustName, isGeneratedName, unlessDeleted } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface ProjectGroupProps {
  /**
   * Project group name, unique within the organization. If omitted, a
   * unique name is generated from the stack, stage and logical ID. Renaming
   * updates the group in place.
   */
  name?: string;
  /** Textual description of the project group. Removing it clears the description. */
  description?: string;
}

export interface ProjectGroupAttributes {
  /** Unique identifier of the project group. */
  projectGroupId: string;
  /** Project group name. */
  name: string;
  /** Id of the organization the project group belongs to. */
  orgId: string;
  /** Textual description of the project group. */
  description: string | undefined;
  /** When the project group was created (ISO 8601). */
  created: string | undefined;
}

export type ProjectGroup = Resource<
  "Braintrust.ProjectGroup",
  ProjectGroupProps,
  ProjectGroupAttributes,
  never,
  Providers,
  ProjectGroupLookup
>;

/**
 * Props for {@link ProjectGroup.lookup}: find a project group this stack
 * doesn't manage by its name.
 */
export interface ProjectGroupLookup {
  /** Project group name. */
  name: string;
}

/**
 * A Braintrust project group: a set of projects that share access. An ACL
 * on the group's `project_group_projects` object applies to every project
 * in it. A project can be in several groups. See
 * [Access control](https://www.braintrust.dev/docs/guides/access-control).
 *
 * Projects join a group through their own `projectGroupIds` prop, so each
 * project owns its memberships. Project groups carry no tags, so a group
 * found under an explicit `name` with no prior state is refused unless
 * adopted (`adopt(true)` or `--adopt`).
 *
 * ### Creating a Project Group
 * **Example:** A project group with two projects in it
 * ```typescript
 * const team = yield* Braintrust.ProjectGroup("SupportTeam", {
 *   description: "Projects the support team works on",
 * });
 * const bot = yield* Braintrust.Project("Bot", {
 *   projectGroupIds: [team.projectGroupId],
 * });
 * const triage = yield* Braintrust.Project("Triage", {
 *   projectGroupIds: [team.projectGroupId],
 * });
 * ```
 *
 * ### Granting access to every project in a group
 * **Example:** Let a group read the group's projects
 * ```typescript
 * const team = yield* Braintrust.ProjectGroup("SupportTeam", {});
 * const readers = yield* Braintrust.Group("SupportReaders", {});
 * yield* Braintrust.Acl("ReadSupportProjects", {
 *   objectType: "project_group_projects",
 *   objectId: team.projectGroupId,
 *   groupId: readers.groupId,
 *   permission: "read",
 * });
 * ```
 *
 * ### Looking up an existing project group
 * **Example:** Add a project to a group made in the Braintrust UI
 * ```typescript
 * const team = Braintrust.ProjectGroup.lookup({ name: "Support" });
 * const project = yield* Braintrust.Project("Bot", {
 *   projectGroupIds: [team.projectGroupId],
 * });
 * ```
 *
 * @resource
 * @product Access control
 */
export const ProjectGroup = Resource<ProjectGroup>("Braintrust.ProjectGroup");

const toAttributes = (group: braintrust.ProjectGroup): ProjectGroupAttributes => ({
  projectGroupId: group.id,
  name: group.name,
  orgId: group.org_id,
  description: group.description || undefined,
  created: group.created ?? undefined,
});

const getById = (projectGroupId: string) =>
  braintrust.getProjectGroup({ project_group_id: projectGroupId }).pipe(
    Effect.map(unlessDeleted),
    Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined),
  );

const findByName = (name: string) =>
  braintrust.listProjectGroups.items({ project_group_name: name }).pipe(
    Stream.filter((group) => group.name === name && !group.deleted_at),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const ProjectGroupProvider = () =>
  Provider.effect(
    ProjectGroup,
    Effect.gen(function* () {
      return {
        stables: ["projectGroupId", "orgId"],
        lookup: Effect.fn(function* ({ name }) {
          const group = yield* findByName(name);
          return group ? toAttributes(group) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const group = yield* getById(output.projectGroupId);
            return group ? toAttributes(group) : undefined;
          }
          const name = yield* braintrustName(id, olds?.name);
          const group = yield* findByName(name);
          if (!group) return undefined;
          const attrs = toAttributes(group);
          // A generated name carries this instance's suffix, so it is ours.
          return olds?.name === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "projectGroupId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* braintrustName(id, news.name);

          // Observe — by id once we have one (it survives renames), else by name.
          let group =
            (output ? yield* getById(output.projectGroupId) : undefined) ??
            (yield* findByName(name));

          // Ensure — POST returns the existing group of the same name
          // unchanged, so a concurrent create converges on one group.
          if (!group) {
            yield* session.note(`Creating project group ${name}...`);
            group = yield* braintrust.createProjectGroup({ name, description: news.description });
          }

          // Sync — PATCH only what differs. `null` leaves a description as
          // it is; `""` clears it. Membership belongs to each Project.
          const update: Omit<braintrust.UpdateProjectGroupRequest, "project_group_id"> = {};
          if (group.name !== name) update.name = name;
          if ((group.description || undefined) !== (news.description || undefined)) {
            update.description = news.description ?? "";
          }
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating project group ${name}...`);
            group = yield* braintrust.updateProjectGroup({
              project_group_id: group.id,
              ...update,
            });
          }

          return toAttributes(group);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteProjectGroup({ project_group_id: output.projectGroupId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const groups = yield* Stream.runCollect(braintrust.listProjectGroups.items({}));
          return groups
            .filter((group) => !group.deleted_at && isGeneratedName(group.name))
            .map(toAttributes);
        }),
      };
    }),
  );
