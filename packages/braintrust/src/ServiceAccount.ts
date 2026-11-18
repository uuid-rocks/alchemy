import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource, type ResourceBinding } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { braintrustName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface ServiceAccountProps {
  /**
   * Service account name. Names don't have to be unique. If omitted, a name
   * is generated from the stack, stage and logical ID. Changing it replaces
   * the service account and revokes its tokens.
   */
  name?: string;
}

export interface ServiceAccountAttributes {
  /** User id of the service account, used in groups and ACLs. */
  serviceAccountId: string;
  /** Service account name. */
  name: string;
  /** The service account's email, as Braintrust names it. Not routable. */
  email: string | undefined;
  /** ACLs granted through bindings, revoked once no binding asks for them. */
  grants?: AppliedGrant[];
}

/** One permission a binding grants a service account on one object. */
export interface ServiceAccountGrant {
  objectType: braintrust.AclObjectType;
  objectId: string;
  permission: braintrust.Permission;
  /** Limits the grant to objects of this type inside the object. */
  restrictObjectType?: braintrust.AclObjectType;
}

/** A {@link ServiceAccountGrant} and the ACL that holds it. */
export interface AppliedGrant extends ServiceAccountGrant {
  aclId: string;
}

/** What a binding grants a {@link ServiceAccount}. */
export interface ServiceAccountBinding {
  grants?: ServiceAccountGrant[];
}

export type ServiceAccount = Resource<
  "Braintrust.ServiceAccount",
  ServiceAccountProps,
  ServiceAccountAttributes,
  ServiceAccountBinding,
  Providers
>;

/**
 * A Braintrust service account: a non-human member of the organization
 * that holds service tokens. Give it access with a `Braintrust.Group` or a
 * `Braintrust.Acl`, and create its tokens with `Braintrust.ServiceToken`.
 * See [Service tokens](https://www.braintrust.dev/docs/guides/access-control#service-tokens).
 *
 * Braintrust's API can create and remove a service account but can't read
 * one back: Alchemy's state is the only record of it. A service account
 * removed outside Alchemy is only noticed when something uses it, and
 * `alchemy unsafe nuke` can't find service accounts a lost state leaked.
 * There is no lookup for the same reason.
 *
 * :::caution
 * Changing `name` replaces the service account. Removing it revokes all of
 * its tokens and drops it from its groups.
 * :::
 *
 * ### Creating a Service Account
 * **Example:** A service account with a token for CI
 * ```typescript
 * const ci = yield* Braintrust.ServiceAccount("CI", {});
 * const token = yield* Braintrust.ServiceToken("CIToken", {
 *   serviceAccountId: ci.serviceAccountId,
 *   expiresInSeconds: 90 * 24 * 60 * 60,
 * });
 * ```
 *
 * ### Giving it access
 * **Example:** Let the service account write to one project
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const ci = yield* Braintrust.ServiceAccount("CI", {});
 * yield* Braintrust.Acl("CiWritesSupport", {
 *   objectType: "project",
 *   objectId: project.projectId,
 *   userId: ci.serviceAccountId,
 *   permission: "update",
 * });
 * ```
 *
 * @resource
 * @product Access control
 */
export const ServiceAccount = Resource<ServiceAccount>("Braintrust.ServiceAccount");

/** Braintrust answered a service account create without the new account. */
export class ServiceAccountNotCreated extends Data.TaggedError("ServiceAccountNotCreated")<{
  accountName: string;
}> {
  override get message() {
    return `Braintrust did not return the new service account ${this.accountName}`;
  }
}

const grantKey = (grant: {
  objectType: string;
  objectId: string;
  permission: string;
  restrictObjectType?: string;
}) => `${grant.objectType}:${grant.objectId}:${grant.permission}:${grant.restrictObjectType ?? ""}`;

const revoke = (aclId: string) =>
  braintrust
    .deleteAcl({ acl_id: aclId })
    .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));

/**
 * Converges the account's binding grants on the union of its bindings: one
 * ACL per distinct grant. Only grants recorded by an earlier sync are ever
 * revoked, so other ACLs on the account stay unless a binding asked for the
 * same grant.
 */
const syncGrants = Effect.fn(function* (
  serviceAccountId: string,
  bindings: ReadonlyArray<ResourceBinding<ServiceAccountBinding>>,
  previous: ReadonlyArray<AppliedGrant>,
) {
  const desired = new Map<string, ServiceAccountGrant>();
  for (const binding of bindings) {
    if ((binding as { action?: string }).action === "delete") continue;
    for (const grant of binding.data?.grants ?? []) desired.set(grantKey(grant), grant);
  }

  const held = new Map<string, string>();
  if (desired.size > 0) {
    const acls = yield* Stream.runCollect(
      braintrust.listOrgAcls.items({ user_id: serviceAccountId }),
    );
    for (const acl of acls) {
      if (acl.user_id !== serviceAccountId || !acl.permission || acl.role_id) continue;
      held.set(
        grantKey({
          objectType: acl.object_type,
          objectId: acl.object_id,
          permission: acl.permission,
          restrictObjectType: acl.restrict_object_type ?? undefined,
        }),
        acl.id,
      );
    }
  }

  const applied: AppliedGrant[] = [];
  for (const [key, grant] of desired) {
    // POST returns an identical existing ACL, so a lost record converges.
    const aclId =
      held.get(key) ??
      (yield* braintrust.createAcl({
        object_type: grant.objectType,
        object_id: grant.objectId,
        user_id: serviceAccountId,
        permission: grant.permission,
        restrict_object_type: grant.restrictObjectType,
      })).id;
    applied.push({ ...grant, aclId });
  }

  for (const grant of previous) {
    if (!desired.has(grantKey(grant))) yield* revoke(grant.aclId);
  }
  return applied.sort((a, b) => grantKey(a).localeCompare(grantKey(b)));
});

export const ServiceAccountProvider = () =>
  Provider.effect(
    ServiceAccount,
    Effect.gen(function* () {
      return {
        stables: ["serviceAccountId"],
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const name = yield* braintrustName(id, news.name);
          const oldName = yield* braintrustName(id, olds.name);
          if (name !== oldName) return { action: "replace" } as const;
        }),
        // No API reads a service account (`GET /v1/user/{id}` answers 403
        // "or the user does not exist" for one that exists), so the cached
        // attributes are the only observation there is.
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session, bindings }) {
          // Observe — the cached id is all there is (see `read`); `diff`
          // replaces the account when its name changes.
          let account = output;

          // Ensure — every create makes a new account, even for a name in use.
          if (!account) {
            const name = yield* braintrustName(id, news.name);
            yield* session.note(`Creating service account ${name}...`);
            const result = yield* braintrust.updateOrganizationMembers({
              invite_users: { service_accounts: [{ name }] },
            });
            const added = result.added_users?.[0];
            if (!added) return yield* new ServiceAccountNotCreated({ accountName: name });
            account = { serviceAccountId: added.id, name, email: added.email ?? undefined };
          }

          // Sync — the grants its bindings ask for.
          const previous = account.grants ?? [];
          if (bindings.length === 0 && previous.length === 0) return account;
          const grants = yield* syncGrants(account.serviceAccountId, bindings, previous);
          return { ...account, grants };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* Effect.forEach(output.grants ?? [], (grant) => revoke(grant.aclId), {
            discard: true,
          });
          // Removing an account that is already gone succeeds.
          yield* braintrust.updateOrganizationMembers({
            remove_users: { ids: [output.serviceAccountId] },
          });
        }),
        // Service accounts can't be listed (see `read`).
        list: () => Effect.succeed([]),
      };
    }),
  );
