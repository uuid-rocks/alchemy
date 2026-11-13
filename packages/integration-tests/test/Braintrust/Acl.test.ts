import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:acl", "live"];

const getAcl = (aclId: string) => braintrust.getAcl({ acl_id: aclId });

const expectAclGone = (aclId: string) =>
  Effect.gen(function* () {
    const exists = yield* getAcl(aclId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

type Grant = Pick<Braintrust.AclProps, "permission" | "restrictObjectType"> & { useRole?: boolean };

/**
 * Grants to a test group on a test project. The project, group and role
 * stay deployed across every step, so replacements never remove a parent.
 */
const program = (grants: Record<string, Grant>) =>
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Project", {});
    const group = yield* Braintrust.Group("Group", {});
    const role = yield* Braintrust.Role("Role", { memberPermissions: [{ permission: "read" }] });
    const acls: Record<string, Braintrust.Acl> = {};
    for (const [id, { useRole, ...grant }] of Object.entries(grants)) {
      acls[id] = yield* Braintrust.Acl(id, {
        objectType: "project",
        objectId: project.projectId,
        groupId: group.groupId,
        ...(useRole ? { roleId: role.roleId } : grant),
      });
    }
    return { projectId: project.projectId, groupId: group.groupId, roleId: role.roleId, acls };
  });

test.provider(
  "grant a permission and a role, replace a grant, revoke one, and delete them",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const both = {
        Read: { permission: "read", restrictObjectType: "dataset" },
        Viewer: { useRole: true },
      } satisfies Record<string, Grant>;
      const first = yield* stack.deploy(program(both));
      const read = first.acls.Read!;
      const viewer = first.acls.Viewer!;

      const created = yield* getAcl(read.aclId);
      expect(created.object_type).toBe("project");
      expect(created.object_id).toBe(first.projectId);
      expect(created.group_id).toBe(first.groupId);
      expect(created.permission).toBe("read");
      expect(created.restrict_object_type).toBe("dataset");
      expect((yield* getAcl(viewer.aclId)).role_id).toBe(first.roleId);
      yield* expectFound(
        Braintrust.Acl.lookup({
          objectType: "project",
          objectId: first.projectId,
          groupId: first.groupId,
          permission: "read",
          restrictObjectType: "dataset",
        }),
        read,
      );

      const plan = yield* stack.plan(program(both));
      expect(plan.resources.Read.action).toBe("noop");
      expect(plan.resources.Viewer.action).toBe("noop");

      // Changing the permission replaces the grant; the role grant is untouched.
      const replaced = yield* stack.deploy(
        program({
          Read: { permission: "update", restrictObjectType: "dataset" },
          Viewer: { useRole: true },
        }),
      );
      const update = replaced.acls.Read!;
      expect(update.aclId).not.toBe(read.aclId);
      expect((yield* getAcl(update.aclId)).permission).toBe("update");
      expect(replaced.acls.Viewer!.aclId).toBe(viewer.aclId);
      yield* expectAclGone(read.aclId);

      // Removing one grant revokes only that one.
      yield* stack.deploy(program({ Viewer: { useRole: true } }));
      yield* expectAclGone(update.aclId);
      expect((yield* getAcl(viewer.aclId)).role_id).toBe(first.roleId);

      yield* stack.destroy();
      yield* expectAclGone(viewer.aclId);
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a grant that already exists is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // The project and group are the test's own; only the grant is foreign.
      const parents = yield* stack.deploy(program({}));
      const foreign = yield* braintrust.createAcl({
        object_type: "project",
        object_id: parents.projectId,
        group_id: parents.groupId,
        permission: "read",
      });

      const app = (allow: boolean) => program({ Read: { permission: "read" } }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.acls.Read!.aclId).toBe(foreign.id);

      yield* stack.destroy();
      yield* expectAclGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
