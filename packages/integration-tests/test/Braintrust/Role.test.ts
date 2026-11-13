import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { testName } from "../names.ts";
import { eventually, expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:role", "live"];

const getRole = (roleId: string) => braintrust.getRole({ role_id: roleId });

const expectRoleGone = (roleId: string) =>
  Effect.gen(function* () {
    const exists = yield* getRole(roleId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

const permissionsOf = (role: braintrust.Role) =>
  (role.member_permissions ?? [])
    .map((p) => `${p.permission}:${p.restrict_object_type ?? ""}`)
    .sort();

/** Id of the system Viewer role, read straight from Braintrust. */
const systemViewerId = braintrust.listRoles.items({ role_name: "Viewer" }).pipe(
  Stream.filter((role) => role.name === "Viewer" && !role.org_id),
  Stream.runHead,
  Effect.map((role) => Option.getOrUndefined(role)?.id),
);

// The inherited role comes from a lookup of a system role.
const withViewer = (props: Braintrust.RoleProps) =>
  Braintrust.Role("Role", {
    ...props,
    memberRoleIds: [Braintrust.Role.lookup({ name: "Viewer" }).roleId],
  });

const datasetEditor: Braintrust.RolePermission[] = [
  { permission: "read", restrictObjectType: "dataset" },
  { permission: "update", restrictObjectType: "dataset" },
];

test.provider(
  "create a role, update its permissions and inherited roles in place, clear them, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const viewerId = yield* systemViewerId;
      expect(viewerId).toMatch(/^[0-9a-f-]{36}$/);

      const role = yield* stack.deploy(
        withViewer({ description: "first", memberPermissions: datasetEditor }),
      );
      const created = yield* getRole(role.roleId);
      expect(created.name).toBe(role.name);
      expect(created.org_id).toBe(role.orgId);
      expect(created.description).toBe("first");
      expect(permissionsOf(created)).toEqual(["read:dataset", "update:dataset"]);
      expect(created.member_roles).toEqual([viewerId]);
      yield* expectFound(Braintrust.Role.lookup({ name: role.name }), role);

      const plan = yield* stack.plan(
        withViewer({ description: "first", memberPermissions: datasetEditor }),
      );
      expect(plan.resources.Role.action).toBe("noop");

      // Partial update: only the description changes; permissions and
      // inherited roles stay as deployed.
      const described = yield* stack.deploy(
        withViewer({ description: "second", memberPermissions: datasetEditor }),
      );
      expect(described.roleId).toBe(role.roleId);
      const afterDescription = yield* getRole(role.roleId);
      expect(afterDescription.description).toBe("second");
      expect(permissionsOf(afterDescription)).toEqual(["read:dataset", "update:dataset"]);
      expect(afterDescription.member_roles).toEqual([viewerId]);

      // One permission kept, one removed, one added.
      const swapped = yield* stack.deploy(
        withViewer({
          description: "second",
          memberPermissions: [
            { permission: "read", restrictObjectType: "dataset" },
            { permission: "delete" },
          ],
        }),
      );
      expect(swapped.roleId).toBe(role.roleId);
      expect(permissionsOf(yield* getRole(role.roleId))).toEqual(["delete:", "read:dataset"]);

      const cleared = yield* stack.deploy(Braintrust.Role("Role", {}));
      expect(cleared.roleId).toBe(role.roleId);
      yield* eventually(getRole(role.roleId), (after) => {
        expect(after.description || undefined).toBeUndefined();
        expect(after.member_permissions ?? []).toEqual([]);
        expect(after.member_roles ?? []).toEqual([]);
      });

      yield* stack.destroy();
      yield* expectRoleGone(role.roleId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an explicitly named role keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const role = yield* stack.deploy(
        Braintrust.Role("Role", { name: testName("alchemy-test-bt-role-a") }),
      );
      const renamed = yield* stack.deploy(
        Braintrust.Role("Role", { name: testName("alchemy-test-bt-role-b") }),
      );
      expect(renamed.roleId).toBe(role.roleId);
      yield* eventually(getRole(role.roleId), (observed) => {
        expect(observed.name).toBe(testName("alchemy-test-bt-role-b"));
      });

      yield* stack.destroy();
      yield* expectRoleGone(role.roleId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a role with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-role");
      const foreign = yield* braintrust.createRole({ name });

      const app = (allow: boolean) =>
        Braintrust.Role("Role", { name, description: "adopted" }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.roleId).toBe(foreign.id);
      yield* eventually(getRole(foreign.id), (observed) => {
        expect(observed.description).toBe("adopted");
      });

      yield* stack.destroy();
      yield* expectRoleGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
