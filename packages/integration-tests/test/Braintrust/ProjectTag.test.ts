import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { testName } from "../names.ts";
import { eventually, expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:project-tag", "live"];

const getTag = (projectTagId: string) => braintrust.getProjectTag({ project_tag_id: projectTagId });

const expectTagGone = (projectTagId: string) =>
  Effect.gen(function* () {
    const exists = yield* getTag(projectTagId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

const inProject = (props: Omit<Braintrust.ProjectTagProps, "projectId">) =>
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Project", {});
    return yield* Braintrust.ProjectTag("Tag", { projectId: project.projectId, ...props });
  });

test.provider(
  "create a project tag, update and clear its fields in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const tag = yield* stack.deploy(inProject({ description: "first", color: "#ef4444" }));
      const created = yield* getTag(tag.projectTagId);
      expect(created.name).toBe(tag.name);
      expect(created.project_id).toBe(tag.projectId);
      expect(created.description).toBe("first");
      expect(created.color).toBe("#ef4444");
      yield* expectFound(
        Braintrust.ProjectTag.lookup({ projectId: tag.projectId, name: tag.name }),
        tag,
      );

      const plan = yield* stack.plan(inProject({ description: "first", color: "#ef4444" }));
      expect(plan.resources.Tag.action).toBe("noop");

      // Changing one field leaves the other as deployed.
      const recolored = yield* stack.deploy(inProject({ description: "first", color: "#3b82f6" }));
      expect(recolored.projectTagId).toBe(tag.projectTagId);
      const afterColor = yield* getTag(tag.projectTagId);
      expect(afterColor.color).toBe("#3b82f6");
      expect(afterColor.description).toBe("first");

      const cleared = yield* stack.deploy(inProject({}));
      expect(cleared.projectTagId).toBe(tag.projectTagId);
      expect(cleared.description).toBeUndefined();
      expect(cleared.color).toBeUndefined();
      yield* eventually(getTag(tag.projectTagId), (after) => {
        expect(after.description || undefined).toBeUndefined();
        expect(after.color || undefined).toBeUndefined();
      });

      yield* stack.destroy();
      yield* expectTagGone(tag.projectTagId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "moving a project tag to another project replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both projects stay deployed across the replacement.
      const program = (target: "A" | "B") =>
        Effect.gen(function* () {
          const a = yield* Braintrust.Project("A", {});
          const b = yield* Braintrust.Project("B", {});
          return yield* Braintrust.ProjectTag("Moving", {
            projectId: target === "A" ? a.projectId : b.projectId,
          });
        });

      const first = yield* stack.deploy(program("A"));
      const moved = yield* stack.deploy(program("B"));
      expect(moved.projectTagId).not.toBe(first.projectTagId);
      yield* eventually(getTag(moved.projectTagId), (observed) => {
        expect(observed.project_id).toBe(moved.projectId);
      });
      yield* expectTagGone(first.projectTagId);

      yield* stack.destroy();
      yield* expectTagGone(moved.projectTagId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an explicitly named project tag keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const tag = yield* stack.deploy(inProject({ name: testName("alchemy-test-bt-tag-a") }));
      const renamed = yield* stack.deploy(inProject({ name: testName("alchemy-test-bt-tag-b") }));
      expect(renamed.projectTagId).toBe(tag.projectTagId);
      yield* eventually(getTag(tag.projectTagId), (observed) => {
        expect(observed.name).toBe(testName("alchemy-test-bt-tag-b"));
      });

      yield* stack.destroy();
      yield* expectTagGone(tag.projectTagId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a project tag with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-tag");

      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      const foreign = yield* braintrust.createProjectTag({ project_id: project.projectId, name });

      const app = (allow: boolean) =>
        inProject({ name, description: "adopted" }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.projectTagId).toBe(foreign.id);
      yield* eventually(getTag(foreign.id), (observed) => {
        expect(observed.description).toBe("adopted");
      });

      yield* stack.destroy();
      yield* expectTagGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
