import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Providers } from "../Providers.ts";

export interface HostGrantsProps {
  /** The host's service account. */
  serviceAccountId: string;
}

export interface HostGrantsAttributes {
  serviceAccountId: string;
}

/** One permission a binding needs on one object. */
export interface HostGrant {
  objectType: braintrust.AclObjectType;
  objectId: string;
  permission: braintrust.Permission;
  /** Limits the grant to objects of this type inside the object. */
  restrictObjectType?: braintrust.AclObjectType;
}

export interface HostGrantsBinding {
  grants: HostGrant[];
}

/**
 * The ACLs a host's bindings grant its service account, as one set.
 *
 * Bindings create the account for the host and own it, so the account's
 * direct-permission ACLs are this resource's state: every reconcile lists
 * them, creates what a binding asks for and revokes the rest. Nothing is
 * recorded, so a deploy that fails between two ACLs converges on the next
 * one. An ACL someone else puts on the account is revoked by the next deploy
 * that changes the host's bindings, not before (the host's account is not
 * for `Braintrust.Acl`). The account is its own resource, so a failed grant
 * never loses it.
 */
export type HostGrants = Resource<
  "Braintrust.HostGrants",
  HostGrantsProps,
  HostGrantsAttributes,
  HostGrantsBinding,
  Providers
>;

export const HostGrants = Resource<HostGrants>("Braintrust.HostGrants");

const grantKey = (grant: {
  objectType: string;
  objectId: string;
  permission: string;
  restrictObjectType?: string;
}) => `${grant.objectType}:${grant.objectId}:${grant.permission}:${grant.restrictObjectType ?? ""}`;

const grantKeys = (bindings: ReadonlyArray<{ data: HostGrantsBinding }>) =>
  new Set(bindings.flatMap((binding) => binding.data.grants.map(grantKey)));

/** The account's direct-permission ACLs (bindings never grant roles), by grant. */
const held = Effect.fn(function* (serviceAccountId: string) {
  const acls = yield* Stream.runCollect(
    braintrust.listOrgAcls.items({ user_id: serviceAccountId }),
  );
  const byKey = new Map<string, string>();
  for (const acl of acls) {
    if (acl.user_id !== serviceAccountId || !acl.permission || acl.role_id) continue;
    byKey.set(
      grantKey({
        objectType: acl.object_type,
        objectId: acl.object_id,
        permission: acl.permission,
        restrictObjectType: acl.restrict_object_type ?? undefined,
      }),
      acl.id,
    );
  }
  return byKey;
});

/** ACLs on a host's account that the deployer could not revoke. */
export class HostGrantsNotRevoked extends Data.TaggedError("HostGrantsNotRevoked")<{
  serviceAccountId: string;
  aclIds: string[];
}> {
  override get message() {
    return `Could not revoke ACLs ${this.aclIds.join(", ")} on service account ${this.serviceAccountId}: the deployer may lack delete access to them`;
  }
}

const revoke = Effect.fn(function* (serviceAccountId: string, aclIds: ReadonlyArray<string>) {
  if (aclIds.length === 0) return;
  yield* Effect.forEach(
    aclIds,
    (aclId) =>
      braintrust
        .deleteAcl({ acl_id: aclId })
        .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void)),
    { discard: true },
  );
  // Braintrust refuses a delete with the same error as one of an ACL that is
  // gone, so only a fresh list tells them apart.
  const remaining = new Set((yield* held(serviceAccountId)).values());
  const kept = aclIds.filter((aclId) => remaining.has(aclId));
  if (kept.length > 0) {
    return yield* new HostGrantsNotRevoked({ serviceAccountId, aclIds: kept });
  }
});

export const HostGrantsProvider = () =>
  Provider.effect(
    HostGrants,
    Effect.gen(function* () {
      return {
        stables: ["serviceAccountId"],
        diff: Effect.fn(function* ({ news, olds, oldBindings, newBindings }) {
          if (!isResolved(news)) return undefined;
          if (news.serviceAccountId !== olds.serviceAccountId) {
            return { action: "replace" } as const;
          }
          // Sids are positional and bindings register in no stable order, so
          // the same grants under shuffled sids are no change.
          if (!isResolved(newBindings)) return undefined;
          const before = grantKeys(oldBindings);
          const after = grantKeys(newBindings);
          if (before.size === after.size && [...after].every((key) => before.has(key))) {
            return { action: "noop" } as const;
          }
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const serviceAccountId = output?.serviceAccountId ?? olds?.serviceAccountId;
          return serviceAccountId ? { serviceAccountId } : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, bindings }) {
          const { serviceAccountId } = news;
          const desired = new Map<string, HostGrant>();
          for (const binding of bindings) {
            for (const grant of binding.data.grants) desired.set(grantKey(grant), grant);
          }
          const observed = yield* held(serviceAccountId);
          for (const [key, grant] of desired) {
            if (observed.has(key)) continue;
            yield* braintrust.createAcl({
              object_type: grant.objectType,
              object_id: grant.objectId,
              user_id: serviceAccountId,
              permission: grant.permission,
              restrict_object_type: grant.restrictObjectType,
            });
          }
          yield* revoke(
            serviceAccountId,
            [...observed].filter(([key]) => !desired.has(key)).map(([, aclId]) => aclId),
          );
          return { serviceAccountId };
        }),
        delete: Effect.fn(function* ({ output }) {
          const observed = yield* held(output.serviceAccountId);
          yield* revoke(output.serviceAccountId, [...observed.values()]);
        }),
        // Service accounts can't be listed, so neither can their grants.
        list: () => Effect.succeed([]),
      };
    }),
  );
