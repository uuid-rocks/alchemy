/**
 * Naming, ownership and not-found helpers shared by every Braintrust
 * resource.
 *
 * Braintrust objects carry no tags or labels, so ownership is decided by
 * name: a name the engine generated ends in this resource instance's
 * suffix and is ours; an explicit name found without prior state belongs
 * to someone else (`Unowned`) unless it is the generation a replacement is
 * replacing. Markers never go in `description` or `metadata`, which users
 * see and edit.
 */
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** The user's name, or one generated from the stack, stage and logical id. */
export const braintrustName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true, maxLength: 128 });

/**
 * Whether a replacement must delete the old object first: it can't coexist
 * with it when both carry the same name in the same parent. Read and
 * reconcile find objects by name, and create returns the existing one, so a
 * create-first replacement would take over the old object and garbage
 * collection would then delete it. A
 * generated name carries the new generation's instance suffix, so it never
 * matches; a name that resolves only at apply might.
 */
export const sameName = (name: unknown, oldName: string | undefined): boolean =>
  name !== undefined && (!isResolved(name) || name === oldName);

/**
 * Whether a name has the exact shape `braintrustName` generates:
 * `{stack}-{id}-{stage}-` plus the 16-character base32 instance suffix, or,
 * when that exceeds 128 characters, the prefix cut to 104 plus an
 * 8-character hash and the suffix. `list` reports only these, so
 * `alchemy unsafe nuke` skips objects people named by hand, unless a name
 * copies this shape: Braintrust stores no other marker to tell them apart.
 */
export const isGeneratedName = (name: string | null | undefined): boolean =>
  typeof name === "string" &&
  (/^[a-z0-9-]+-[a-z0-9-]+-[a-z0-9-]+-[a-z2-7]{16}$/.test(name) ||
    /^[a-z0-9-]{104}[a-z2-7]{24}$/.test(name));

/**
 * `undefined` for an object Braintrust has soft-deleted. Reads by id of a
 * deleted object fail with `NotFoundOrForbidden`, which callers catch; this
 * covers a list or read that still returns it with `deleted_at` set.
 */
export const unlessDeleted = <A extends { readonly deleted_at?: string | null }>(
  object: A | undefined,
): A | undefined => (object?.deleted_at ? undefined : object);

/** An object whose delete was refused, and that is still there. */
export class BraintrustObjectNotDeleted extends Data.TaggedError("BraintrustObjectNotDeleted")<{
  objectType: string;
  objectId: string;
}> {
  override get message() {
    return `Could not delete Braintrust ${this.objectType} ${this.objectId}: it still exists, so the deployer may lack delete access to it`;
  }
}

/**
 * The handler for a delete's `NotFoundOrForbidden`. Braintrust refuses a
 * delete with the same error it gives for an object that is gone, so only a
 * fresh `observe` tells them apart: absent or soft-deleted is gone, anything
 * else fails instead of dropping the object from state while it lives on.
 */
export const confirmDeleted = <A extends object, E, R>(
  objectType: string,
  objectId: string,
  observe: Effect.Effect<A | undefined, E, R>,
) =>
  Effect.flatMap(observe, (object) =>
    object === undefined || ("deleted_at" in object && object.deleted_at)
      ? Effect.void
      : Effect.fail(new BraintrustObjectNotDeleted({ objectType, objectId })),
  );
