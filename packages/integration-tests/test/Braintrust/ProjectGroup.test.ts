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

const tags = ["provider:braintrust", "provider:braintrust:project-group", "live"];

const getProjectGroup = (projectGroupId: string) =>
  braintrust.getProjectGroup({ project_group_id: projectGroupId });

const expectProjectGroupGone = (projectGroupId: string) =>
  Effect.gen(function* () {
    const exists = yield* getProjectGroup(projectGroupId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

const membersOf = (projectGroupId: string) =>
  getProjectGroup(projectGroupId).pipe(Effect.map((group) => group.member_projects));

test.provider(
  "create a project group, update and clear its description in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const group = yield* stack.deploy(
        Braintrust.ProjectGroup("ProjectGroup", { description: "first" }),
      );
      const created = yield* getProjectGroup(group.projectGroupId);
      expect(created.name).toBe(group.name);
      expect(created.org_id).toBe(group.orgId);
      expect(created.description).toBe("first");
      yield* expectFound(Braintrust.ProjectGroup.lookup({ name: group.name }), group);

      const plan = yield* stack.plan(
        Braintrust.ProjectGroup("ProjectGroup", { description: "first" }),
      );
      expect(plan.resources.ProjectGroup.action).toBe("noop");

      const updated = yield* stack.deploy(
        Braintrust.ProjectGroup("ProjectGroup", { description: "second" }),
      );
      expect(updated.projectGroupId).toBe(group.projectGroupId);
      expect((yield* getProjectGroup(group.projectGroupId)).description).toBe("second");

      const cleared = yield* stack.deploy(Braintrust.ProjectGroup("ProjectGroup", {}));
      expect(cleared.projectGroupId).toBe(group.projectGroupId);
      expect((yield* getProjectGroup(group.projectGroupId)).description || undefined).toBe(
        undefined,
      );

      yield* stack.destroy();
      yield* expectProjectGroupGone(group.projectGroupId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a project joins, moves between and leaves project groups through projectGroupIds",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both groups stay deployed throughout; only the project's list changes.
      const program = (groups: ("A" | "B")[], description?: string) =>
        Effect.gen(function* () {
          const a = yield* Braintrust.ProjectGroup("A", {});
          const b = yield* Braintrust.ProjectGroup("B", {});
          const ids = { A: a.projectGroupId, B: b.projectGroupId };
          const project = yield* Braintrust.Project("Project", {
            description,
            projectGroupIds: groups.map((group) => ids[group]),
          });
          return { a: a.projectGroupId, b: b.projectGroupId, projectId: project.projectId };
        });

      const first = yield* stack.deploy(program(["A"], "kept"));
      expect(yield* membersOf(first.a)).toEqual([first.projectId]);
      expect(yield* membersOf(first.b)).toEqual([]);

      const both = yield* stack.deploy(program(["A", "B"], "kept"));
      expect(both.projectId).toBe(first.projectId);
      expect(yield* membersOf(first.a)).toEqual([first.projectId]);
      expect(yield* membersOf(first.b)).toEqual([first.projectId]);

      // Partial update: moving the project leaves its description alone.
      yield* stack.deploy(program(["B"], "kept"));
      expect(yield* membersOf(first.a)).toEqual([]);
      expect(yield* membersOf(first.b)).toEqual([first.projectId]);
      expect((yield* braintrust.getProject({ project_id: first.projectId })).description).toBe(
        "kept",
      );

      yield* stack.deploy(program([], "kept"));
      expect(yield* membersOf(first.a)).toEqual([]);
      expect(yield* membersOf(first.b)).toEqual([]);

      yield* stack.destroy();
      yield* expectProjectGroupGone(first.a);
      yield* expectProjectGroupGone(first.b);
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a project without projectGroupIds keeps memberships made outside Alchemy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (description: string) =>
        Effect.gen(function* () {
          const group = yield* Braintrust.ProjectGroup("Group", {});
          const project = yield* Braintrust.Project("Project", { description });
          return { groupId: group.projectGroupId, projectId: project.projectId };
        });

      const { groupId, projectId } = yield* stack.deploy(program("first"));
      // Out of band, as someone would in the Braintrust UI.
      yield* braintrust.updateProjectGroup({
        project_group_id: groupId,
        add_member_projects: [projectId],
      });

      yield* stack.deploy(program("second"));
      expect(yield* membersOf(groupId)).toEqual([projectId]);

      yield* stack.destroy();
      yield* expectProjectGroupGone(groupId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an explicitly named project group keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const group = yield* stack.deploy(
        Braintrust.ProjectGroup("ProjectGroup", { name: testName("alchemy-test-bt-pg-a") }),
      );
      const renamed = yield* stack.deploy(
        Braintrust.ProjectGroup("ProjectGroup", { name: testName("alchemy-test-bt-pg-b") }),
      );
      expect(renamed.projectGroupId).toBe(group.projectGroupId);
      expect((yield* getProjectGroup(group.projectGroupId)).name).toBe(
        testName("alchemy-test-bt-pg-b"),
      );

      yield* stack.destroy();
      yield* expectProjectGroupGone(group.projectGroupId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a project group with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-pg");
      const foreign = yield* braintrust.createProjectGroup({ name });

      const app = (allow: boolean) =>
        Braintrust.ProjectGroup("ProjectGroup", { name, description: "adopted" }).pipe(
          adopt(allow),
        );

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.projectGroupId).toBe(foreign.id);
      expect((yield* getProjectGroup(foreign.id)).description).toBe("adopted");

      yield* stack.destroy();
      yield* expectProjectGroupGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
