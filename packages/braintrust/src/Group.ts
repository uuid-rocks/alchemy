import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { braintrustName, isGeneratedName, unlessDeleted } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface GroupProps {
  /**
   * Group name, unique within the organization. If omitted, a unique name
   * is generated from the stack, stage and logical ID. Renaming a group
   * updates it in place; ACLs granted to it keep working.
   */
  name?: string;
  /** Textual description of the group. Removing it clears the description. */
  description?: string;
  /**
   * Ids of the users and service accounts in the group, e.g.
   * `serviceAccount.serviceAccountId`. Users not listed are removed.
   * @default []
   */
  memberUserIds?: string[];
  /**
   * Ids of the groups whose members this group inherits.
   * @default []
   */
  memberGroupIds?: string[];
}

export interface GroupAttributes {
  /** Unique identifier of the group. */
  groupId: string;
  /** Group name. */
  name: string;
  /** Id of the organization the group belongs to. */
  orgId: string;
  /** Textual description of the group. */
  description: string | undefined;
  /** Ids of the users and service accounts in the group. */
  memberUserIds: string[];
  /** Ids of the groups this group inherits members from. */
  memberGroupIds: string[];
  /** When the group was created (ISO 8601). */
  created: string | undefined;
}

export type Group = Resource<
  "Braintrust.Group",
  GroupProps,
  GroupAttributes,
  never,
  Providers,
  GroupLookup
>;

/**
 * Props for {@link Group.lookup}: find a group this stack doesn't manage by
 * its name, such as the built-in `Owners`, `Engineers` or `Viewers`.
 */
export interface GroupLookup {
  /** Group name. */
  name: string;
}

/**
 * A Braintrust permission group: a set of users and service accounts that
 * ACLs grant roles or permissions to. A group can inherit the members of
 * other groups. See
 * [Access control](https://www.braintrust.dev/docs/guides/access-control).
 *
 * Groups carry no tags, so Alchemy recognizes its own by name: a group found
 * under an explicit `name` with no prior state is refused unless adopted
 * (`adopt(true)` or `--adopt`). Once managed, its members are exactly the
 * ones you list.
 *
 * ### Creating a Group
 * **Example:** A group with a service account in it
 * ```typescript
 * const ci = yield* Braintrust.ServiceAccount("CI", {});
 * const group = yield* Braintrust.Group("Evaluators", {
 *   description: "Runs evals from CI",
 *   memberUserIds: [ci.serviceAccountId],
 * });
 * ```
 *
 * **Example:** A group that includes everyone in another group
 * ```typescript
 * const engineers = Braintrust.Group.lookup({ name: "Engineers" });
 * const group = yield* Braintrust.Group("Reviewers", {
 *   memberGroupIds: [engineers.groupId],
 * });
 * ```
 *
 * ### Granting access to a Group
 * **Example:** Let the group read one project
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const group = yield* Braintrust.Group("Readers", {});
 * yield* Braintrust.Acl("ReadersOnSupport", {
 *   objectType: "project",
 *   objectId: project.projectId,
 *   groupId: group.groupId,
 *   permission: "read",
 * });
 * ```
 *
 * ### Looking up an existing group
 * **Example:** Reference the built-in Viewers group
 * ```typescript
 * const viewers = Braintrust.Group.lookup({ name: "Viewers" });
 * ```
 *
 * @resource
 * @product Access control
 */
export const Group = Resource<Group>("Braintrust.Group");

const toAttributes = (group: braintrust.Group): GroupAttributes => ({
  groupId: group.id,
  name: group.name,
  orgId: group.org_id,
  description: group.description || undefined,
  memberUserIds: [...(group.member_users ?? [])],
  memberGroupIds: [...(group.member_groups ?? [])],
  created: group.created ?? undefined,
});

const getById = (groupId: string) =>
  braintrust.getGroup({ group_id: groupId }).pipe(
    Effect.map(unlessDeleted),
    Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined),
  );

const findByName = (name: string) =>
  braintrust.listGroups.items({ group_name: name }).pipe(
    Stream.filter((group) => group.name === name && !group.deleted_at),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

const delta = (observed: readonly string[], desired: readonly string[]) => ({
  add: desired.filter((id) => !observed.includes(id)),
  remove: observed.filter((id) => !desired.includes(id)),
});

export const GroupProvider = () =>
  Provider.effect(
    Group,
    Effect.gen(function* () {
      return {
        stables: ["groupId", "orgId"],
        lookup: Effect.fn(function* ({ name }) {
          const group = yield* findByName(name);
          return group ? toAttributes(group) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const group = yield* getById(output.groupId);
            return group ? toAttributes(group) : undefined;
          }
          const name = yield* braintrustName(id, olds?.name);
          const group = yield* findByName(name);
          if (!group) return undefined;
          const attrs = toAttributes(group);
          // A generated name carries this instance's suffix, so it is ours.
          return olds?.name === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "groupId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* braintrustName(id, news.name);

          // Observe — by id once we have one (it survives renames), else by name.
          let group =
            (output ? yield* getById(output.groupId) : undefined) ?? (yield* findByName(name));

          // Ensure — POST returns the existing group of the same name
          // unchanged, so a concurrent create converges on one group.
          if (!group) {
            yield* session.note(`Creating group ${name}...`);
            group = yield* braintrust.createGroup({
              name,
              description: news.description,
              member_users: news.memberUserIds,
              member_groups: news.memberGroupIds,
            });
          }

          // Sync — PATCH the name and description that differ, and add or
          // remove members against the observed sets. `null` leaves a
          // description as it is; `""` clears it.
          const update: Omit<braintrust.UpdateGroupRequest, "group_id"> = {};
          if (group.name !== name) update.name = name;
          if ((group.description || undefined) !== (news.description || undefined)) {
            update.description = news.description ?? "";
          }
          const users = delta(group.member_users ?? [], news.memberUserIds ?? []);
          if (users.add.length > 0) update.add_member_users = users.add;
          if (users.remove.length > 0) update.remove_member_users = users.remove;
          const groups = delta(group.member_groups ?? [], news.memberGroupIds ?? []);
          if (groups.add.length > 0) update.add_member_groups = groups.add;
          if (groups.remove.length > 0) update.remove_member_groups = groups.remove;
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating group ${name}...`);
            group = yield* braintrust.updateGroup({ group_id: group.id, ...update });
          }

          return toAttributes(group);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteGroup({ group_id: output.groupId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const groups = yield* Stream.runCollect(braintrust.listGroups.items({}));
          return groups
            .filter((group) => !group.deleted_at && isGeneratedName(group.name))
            .map(toAttributes);
        }),
      };
    }),
  );
