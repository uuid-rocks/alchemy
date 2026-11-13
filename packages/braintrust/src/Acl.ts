import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface AclProps {
  /**
   * Type of the object the grant applies to: `organization`, `project`,
   * `experiment`, `dataset`, `prompt`, `group`, `role`, `project_group`,
   * `project_group_projects`, and so on.
   */
  objectType: braintrust.AclObjectType;
  /**
   * Id of the object the grant applies to, e.g. `project.projectId`. For
   * `organization`, the organization id (`project.orgId`).
   */
  objectId: string;
  /** Id of the user or service account granted access. Set this or `groupId`. */
  userId?: string;
  /** Id of the group granted access, e.g. `group.groupId`. Set this or `userId`. */
  groupId?: string;
  /** Permission granted. Set this or `roleId`. */
  permission?: braintrust.Permission;
  /** Id of the role granted, e.g. `role.roleId`. Set this or `permission`. */
  roleId?: string;
  /**
   * Limit a direct `permission` to objects of this type under the object,
   * e.g. `dataset` to grant on a project's datasets only. Can't be used with
   * `roleId`.
   */
  restrictObjectType?: braintrust.AclObjectType;
}

export interface AclAttributes {
  /** Unique identifier of the ACL. */
  aclId: string;
  /** Type of the object the grant applies to. */
  objectType: braintrust.AclObjectType;
  /** Id of the object the grant applies to. */
  objectId: string;
  /** Id of the user or service account granted access. */
  userId: string | undefined;
  /** Id of the group granted access. */
  groupId: string | undefined;
  /** Permission granted. */
  permission: braintrust.Permission | undefined;
  /** Id of the role granted. */
  roleId: string | undefined;
  /** Object type the permission is limited to. */
  restrictObjectType: braintrust.AclObjectType | undefined;
  /** Id of the organization the object belongs to. */
  orgId: string;
  /** When the ACL was created (ISO 8601). */
  created: string | undefined;
}

export type Acl = Resource<"Braintrust.Acl", AclProps, AclAttributes, never, Providers, AclLookup>;

/**
 * Props for {@link Acl.lookup}: find a grant this stack doesn't manage by
 * its full content.
 */
export type AclLookup = AclProps;

/**
 * A Braintrust ACL: grants one permission or role to one user or group on
 * one object. Grants are inherited down the object hierarchy, so a grant
 * on a project covers its experiments, datasets and logs. See
 * [Access control](https://www.braintrust.dev/docs/guides/access-control).
 *
 * An ACL is identified by its content and can't be edited, so changing any
 * prop replaces it. Destroying it revokes only that grant. A grant that
 * already exists when Alchemy first deploys it is refused unless adopted
 * (`adopt(true)` or `--adopt`), so destroying the stack never revokes access
 * someone else gave.
 *
 * :::caution
 * Every prop replaces the ACL: the new grant is created before the old one
 * is revoked.
 * :::
 *
 * ### Granting a role
 * **Example:** Grant a custom role to a group on a project
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const group = yield* Braintrust.Group("Annotators", {});
 * const role = yield* Braintrust.Role("Annotator", {
 *   memberPermissions: [{ permission: "read" }, { permission: "update" }],
 * });
 * yield* Braintrust.Acl("AnnotatorsOnSupport", {
 *   objectType: "project",
 *   objectId: project.projectId,
 *   groupId: group.groupId,
 *   roleId: role.roleId,
 * });
 * ```
 *
 * ### Granting a permission
 * **Example:** Let a service account read one project's datasets
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const ci = yield* Braintrust.ServiceAccount("CI", {});
 * yield* Braintrust.Acl("CiReadsDatasets", {
 *   objectType: "project",
 *   objectId: project.projectId,
 *   userId: ci.serviceAccountId,
 *   permission: "read",
 *   restrictObjectType: "dataset",
 * });
 * ```
 *
 * ### Looking up an existing grant
 * **Example:** Reference a grant made in the Braintrust UI
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const viewers = Braintrust.Group.lookup({ name: "Viewers" });
 * const grant = Braintrust.Acl.lookup({
 *   objectType: "project",
 *   objectId: project.projectId,
 *   groupId: viewers.groupId,
 *   permission: "read",
 * });
 * ```
 *
 * @resource
 * @product Access control
 */
export const Acl = Resource<Acl>("Braintrust.Acl");

const toAttributes = (acl: braintrust.Acl): AclAttributes => ({
  aclId: acl.id,
  objectType: acl.object_type,
  objectId: acl.object_id,
  userId: acl.user_id ?? undefined,
  groupId: acl.group_id ?? undefined,
  permission: acl.permission ?? undefined,
  roleId: acl.role_id ?? undefined,
  restrictObjectType: acl.restrict_object_type ?? undefined,
  orgId: acl._object_org_id,
  created: acl.created ?? undefined,
});

const getById = (aclId: string) =>
  braintrust
    .getAcl({ acl_id: aclId })
    .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined));

const matches = (acl: braintrust.Acl, props: AclProps) =>
  acl.object_type === props.objectType &&
  acl.object_id === props.objectId &&
  (acl.user_id ?? undefined) === props.userId &&
  (acl.group_id ?? undefined) === props.groupId &&
  (acl.permission ?? undefined) === props.permission &&
  (acl.role_id ?? undefined) === props.roleId &&
  (acl.restrict_object_type ?? undefined) === props.restrictObjectType;

const findByContent = (props: AclProps) =>
  braintrust.listAcls
    .items({
      object_type: props.objectType,
      object_id: props.objectId,
      user_id: props.userId,
      group_id: props.groupId,
      permission: props.permission,
      role_id: props.roleId,
      restrict_object_type: props.restrictObjectType,
    })
    .pipe(
      Stream.filter((acl) => matches(acl, props)),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
    );

export const AclProvider = () =>
  Provider.effect(
    Acl,
    Effect.gen(function* () {
      return {
        stables: ["aclId", "orgId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // An ACL has no update; any change is a new grant.
          if (!deepEqual(news, olds)) return { action: "replace" } as const;
        }),
        lookup: Effect.fn(function* (props) {
          const acl = yield* findByContent(props);
          return acl ? toAttributes(acl) : undefined;
        }),
        read: Effect.fn(function* ({ olds, output, previous }) {
          if (output) {
            const acl = yield* getById(output.aclId);
            return acl ? toAttributes(acl) : undefined;
          }
          const acl = yield* findByContent(olds);
          if (!acl) return undefined;
          // Every prop is user-chosen, so a grant found without state may
          // be someone else's.
          return unownedUnlessPrevious(toAttributes(acl), previous, "aclId");
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          // Observe — by id once we have one, else by content.
          const cached = output ? yield* getById(output.aclId) : undefined;
          let acl =
            (cached && matches(cached, news) ? cached : undefined) ?? (yield* findByContent(news));

          // Ensure — POST returns an identical existing ACL, so a concurrent
          // create converges on one grant. There is nothing to sync.
          if (!acl) {
            yield* session.note(`Granting ${news.objectType} ${news.objectId}...`);
            acl = yield* braintrust.createAcl({
              object_type: news.objectType,
              object_id: news.objectId,
              user_id: news.userId,
              group_id: news.groupId,
              permission: news.permission,
              role_id: news.roleId,
              restrict_object_type: news.restrictObjectType,
            });
          }

          return toAttributes(acl);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Gone also when the object or principal was deleted first: the
          // grant then can no longer be read or revoked.
          yield* braintrust
            .deleteAcl({ acl_id: output.aclId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          // ACLs have no name. Report the grants to groups Alchemy named, so
          // `alchemy unsafe nuke` never revokes access people set up.
          const groups = yield* Stream.runCollect(braintrust.listGroups.items({}));
          const owned = groups.filter((group) => !group.deleted_at && isGeneratedName(group.name));
          const acls = yield* Effect.forEach(owned, (group) =>
            Stream.runCollect(braintrust.listOrgAcls.items({ group_id: group.id })),
          );
          return acls.flat().map(toAttributes);
        }),
      };
    }),
  );
