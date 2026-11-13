import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { testName } from "../names.ts";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:group", "live"];

const getGroup = (groupId: string) => braintrust.getGroup({ group_id: groupId });

const expectGroupGone = (groupId: string) =>
  Effect.gen(function* () {
    const exists = yield* getGroup(groupId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

/**
 * A group whose members are test-owned: a service account and a second
 * group, both deployed in the same stack and kept across every step.
 */
const program = (props: { description?: string; withUser?: boolean; withGroup?: boolean }) =>
  Effect.gen(function* () {
    const account = yield* Braintrust.ServiceAccount("Member", {});
    const inner = yield* Braintrust.Group("Inner", {});
    const group = yield* Braintrust.Group("Group", {
      description: props.description,
      memberUserIds: props.withUser ? [account.serviceAccountId] : undefined,
      memberGroupIds: props.withGroup ? [inner.groupId] : undefined,
    });
    return { group, userId: account.serviceAccountId, innerId: inner.groupId };
  });

test.provider(
  "create a group, update its description and members in place, clear them, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const full = program({ description: "first", withUser: true, withGroup: true });
      const { group, userId, innerId } = yield* stack.deploy(full);
      const created = yield* getGroup(group.groupId);
      expect(created.name).toBe(group.name);
      expect(created.description).toBe("first");
      expect(created.member_users).toEqual([userId]);
      expect(created.member_groups).toEqual([innerId]);
      yield* expectFound(Braintrust.Group.lookup({ name: group.name }), group);

      const plan = yield* stack.plan(full);
      expect(plan.resources.Group.action).toBe("noop");

      // Partial update: only the description changes; members stay.
      const described = yield* stack.deploy(
        program({ description: "second", withUser: true, withGroup: true }),
      );
      expect(described.group.groupId).toBe(group.groupId);
      const afterDescription = yield* getGroup(group.groupId);
      expect(afterDescription.description).toBe("second");
      expect(afterDescription.member_users).toEqual([userId]);
      expect(afterDescription.member_groups).toEqual([innerId]);

      // Drop the user, keep the group.
      yield* stack.deploy(program({ description: "second", withGroup: true }));
      const afterDrop = yield* getGroup(group.groupId);
      expect(afterDrop.member_users ?? []).toEqual([]);
      expect(afterDrop.member_groups).toEqual([innerId]);

      const cleared = yield* stack.deploy(program({}));
      expect(cleared.group.groupId).toBe(group.groupId);
      const after = yield* getGroup(group.groupId);
      expect(after.description || undefined).toBeUndefined();
      expect(after.member_users ?? []).toEqual([]);
      expect(after.member_groups ?? []).toEqual([]);

      yield* stack.destroy();
      yield* expectGroupGone(group.groupId);
      yield* expectGroupGone(innerId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an explicitly named group keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const group = yield* stack.deploy(
        Braintrust.Group("Group", { name: testName("alchemy-test-bt-group-a") }),
      );
      const renamed = yield* stack.deploy(
        Braintrust.Group("Group", { name: testName("alchemy-test-bt-group-b") }),
      );
      expect(renamed.groupId).toBe(group.groupId);
      expect((yield* getGroup(group.groupId)).name).toBe(testName("alchemy-test-bt-group-b"));

      yield* stack.destroy();
      yield* expectGroupGone(group.groupId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a group with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-group");
      const foreign = yield* braintrust.createGroup({ name });

      const app = (allow: boolean) =>
        Braintrust.Group("Group", { name, description: "adopted" }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.groupId).toBe(foreign.id);
      expect((yield* getGroup(foreign.id)).description).toBe("adopted");

      yield* stack.destroy();
      yield* expectGroupGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
