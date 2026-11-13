import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { braintrustName, isGeneratedName, unlessDeleted } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

/** A permission a role grants, optionally limited to one object type. */
export interface RolePermission {
  /**
   * The operation the permission allows: `create`, `read`, `update`,
   * `delete`, `create_acls`, `read_acls`, `update_acls` or `delete_acls`.
   */
  permission: braintrust.Permission;
  /**
   * Restrict the permission to objects of this type under the object the
   * role is granted on, e.g. `dataset` to allow reading datasets only.
   * Omit to apply it to every object type.
   */
  restrictObjectType?: braintrust.AclObjectType;
}

export interface RoleProps {
  /**
   * Role name, unique within the organization. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Renaming a role updates
   * it in place; ACLs that grant it keep working.
   */
  name?: string;
  /** Textual description of the role. Removing it clears the description. */
  description?: string;
  /**
   * Permissions the role grants. Removing one revokes it.
   * @default []
   */
  memberPermissions?: RolePermission[];
  /**
   * Ids of roles this role inherits every permission from, e.g. a system
   * role found with `Braintrust.Role.lookup({ name: "Viewer" })`.
   * @default []
   */
  memberRoleIds?: string[];
}

export interface RoleAttributes {
  /** Unique identifier of the role. */
  roleId: string;
  /** Role name. */
  name: string;
  /**
   * Id of the organization the role belongs to; `undefined` for a system
   * role such as `Owner`, `Engineer` or `Viewer`.
   */
  orgId: string | undefined;
  /** Textual description of the role. */
  description: string | undefined;
  /** Permissions the role grants. */
  memberPermissions: RolePermission[];
  /** Ids of the roles this role inherits from. */
  memberRoleIds: string[];
  /** When the role was created (ISO 8601). */
  created: string | undefined;
}

export type Role = Resource<
  "Braintrust.Role",
  RoleProps,
  RoleAttributes,
  never,
  Providers,
  RoleLookup
>;

/**
 * Props for {@link Role.lookup}: find a role this stack doesn't manage by
 * its name. System roles (`Owner`, `Engineer`, `Viewer`, …) are found too.
 */
export interface RoleLookup {
  /** Role name. */
  name: string;
}

/**
 * A Braintrust role: a named set of permissions that an ACL grants to a
 * user or group on an object. Roles can inherit from other roles, including
 * Braintrust's system roles. See
 * [Access control](https://www.braintrust.dev/docs/guides/access-control).
 *
 * Roles carry no tags, so Alchemy recognizes its own by name: a role found
 * under an explicit `name` with no prior state is refused unless adopted
 * (`adopt(true)` or `--adopt`).
 *
 * ### Creating a Role
 * **Example:** A role that can read and update datasets
 * ```typescript
 * const role = yield* Braintrust.Role("DatasetEditor", {
 *   description: "Read and edit datasets",
 *   memberPermissions: [
 *     { permission: "read", restrictObjectType: "dataset" },
 *     { permission: "update", restrictObjectType: "dataset" },
 *   ],
 * });
 * ```
 *
 * **Example:** A role that extends the system Viewer role
 * ```typescript
 * const viewer = Braintrust.Role.lookup({ name: "Viewer" });
 * const role = yield* Braintrust.Role("Reviewer", {
 *   memberRoleIds: [viewer.roleId],
 *   memberPermissions: [{ permission: "update", restrictObjectType: "experiment" }],
 * });
 * ```
 *
 * ### Granting a Role
 * **Example:** Grant the role to a group on a project
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
 * ### Looking up an existing role
 * **Example:** Reference the system Engineer role
 * ```typescript
 * const engineer = Braintrust.Role.lookup({ name: "Engineer" });
 * ```
 *
 * @resource
 * @product Access control
 */
export const Role = Resource<Role>("Braintrust.Role");

const permissionKey = (p: RolePermission) => `${p.permission}:${p.restrictObjectType ?? ""}`;

const toPermission = (p: braintrust.RoleMemberPermissionsItem): RolePermission =>
  p.restrict_object_type
    ? { permission: p.permission, restrictObjectType: p.restrict_object_type }
    : { permission: p.permission };

const toAttributes = (role: braintrust.Role): RoleAttributes => ({
  roleId: role.id,
  name: role.name,
  orgId: role.org_id ?? undefined,
  description: role.description || undefined,
  memberPermissions: (role.member_permissions ?? []).map(toPermission),
  memberRoleIds: [...(role.member_roles ?? [])],
  created: role.created ?? undefined,
});

const getById = (roleId: string) =>
  braintrust.getRole({ role_id: roleId }).pipe(
    Effect.map(unlessDeleted),
    Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined),
  );

const findByName = (name: string) =>
  braintrust.listRoles.items({ role_name: name }).pipe(
    Stream.filter((role) => role.name === name && !role.deleted_at),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

const wire = (p: RolePermission) => ({
  permission: p.permission,
  restrict_object_type: p.restrictObjectType ?? null,
});

export const RoleProvider = () =>
  Provider.effect(
    Role,
    Effect.gen(function* () {
      return {
        stables: ["roleId", "orgId"],
        lookup: Effect.fn(function* ({ name }) {
          const role = yield* findByName(name);
          return role ? toAttributes(role) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const role = yield* getById(output.roleId);
            return role ? toAttributes(role) : undefined;
          }
          const role = yield* findByName(yield* braintrustName(id, olds?.name));
          if (!role) return undefined;
          const attrs = toAttributes(role);
          // A generated name carries this instance's suffix, so it is ours.
          return olds?.name === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "roleId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* braintrustName(id, news.name);

          // Observe — by id once we have one (it survives renames), else by name.
          let role =
            (output ? yield* getById(output.roleId) : undefined) ?? (yield* findByName(name));

          // Ensure — POST returns the existing role of the same name
          // unchanged, so a concurrent create converges on one role.
          if (!role) {
            yield* session.note(`Creating role ${name}...`);
            role = yield* braintrust.createRole({
              name,
              description: news.description,
              member_permissions: news.memberPermissions?.map(wire),
              member_roles: news.memberRoleIds,
            });
          }

          // Sync — PATCH the name and description that differ, and add or
          // remove the permissions and inherited roles that differ from the
          // observed sets. `null` leaves a description as it is; `""` clears it.
          const update: Omit<braintrust.UpdateRoleRequest, "role_id"> = {};
          if (role.name !== name) update.name = name;
          if ((role.description || undefined) !== (news.description || undefined)) {
            update.description = news.description ?? "";
          }
          const observed = (role.member_permissions ?? []).map(toPermission);
          const desired = news.memberPermissions ?? [];
          const observedKeys = new Set(observed.map(permissionKey));
          const desiredKeys = new Set(desired.map(permissionKey));
          const addPermissions = desired.filter((p) => !observedKeys.has(permissionKey(p)));
          const removePermissions = observed.filter((p) => !desiredKeys.has(permissionKey(p)));
          if (addPermissions.length > 0) update.add_member_permissions = addPermissions.map(wire);
          if (removePermissions.length > 0) {
            update.remove_member_permissions = removePermissions.map(wire);
          }
          const observedRoles = role.member_roles ?? [];
          const desiredRoles = news.memberRoleIds ?? [];
          const addRoles = desiredRoles.filter((r) => !observedRoles.includes(r));
          const removeRoles = observedRoles.filter((r) => !desiredRoles.includes(r));
          if (addRoles.length > 0) update.add_member_roles = addRoles;
          if (removeRoles.length > 0) update.remove_member_roles = removeRoles;
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating role ${name}...`);
            role = yield* braintrust.updateRole({ role_id: role.id, ...update });
          }

          return toAttributes(role);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteRole({ role_id: output.roleId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const roles = yield* Stream.runCollect(braintrust.listRoles.items({}));
          // System roles have no org and are never Alchemy's.
          return roles
            .filter((role) => !role.deleted_at && role.org_id && isGeneratedName(role.name))
            .map(toAttributes);
        }),
      };
    }),
  );
