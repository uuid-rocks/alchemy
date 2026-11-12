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

const tags = ["provider:braintrust", "provider:braintrust:project", "live"];

const getProject = (projectId: string) => braintrust.getProject({ project_id: projectId });

const expectProjectGone = (projectId: string) =>
  Effect.gen(function* () {
    const exists = yield* getProject(projectId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

test.provider(
  "create a project, update its description and settings in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = yield* stack.deploy(Braintrust.Project("Project", { description: "first" }));
      expect(project.name).toMatch(/^braintrust-project-.*[a-z2-7]{16}$/);
      const created = yield* getProject(project.projectId);
      expect(created.name).toBe(project.name);
      expect(created.description).toBe("first");
      expect(created.org_id).toBe(project.orgId);
      yield* expectFound(Braintrust.Project.lookup({ name: project.name }), project);

      // An unchanged redeploy plans nothing.
      const plan = yield* stack.plan(Braintrust.Project("Project", { description: "first" }));
      expect(plan.resources.Project.action).toBe("noop");

      const updated = yield* stack.deploy(
        Braintrust.Project("Project", {
          description: "second",
          settings: { comparisonKey: "metadata.case_id", blindReviews: true },
        }),
      );
      expect(updated.projectId).toBe(project.projectId);
      const observed = yield* getProject(project.projectId);
      expect(observed.description).toBe("second");
      expect(observed.settings?.comparison_key).toBe("metadata.case_id");
      expect(observed.settings?.blind_reviews).toBe(true);

      // Removing the description and a setting clears them; the rest stays.
      const cleared = yield* stack.deploy(
        Braintrust.Project("Project", { settings: { comparisonKey: "metadata.case_id" } }),
      );
      expect(cleared.projectId).toBe(project.projectId);
      expect(cleared.description).toBeUndefined();
      const after = yield* getProject(project.projectId);
      expect(after.description ?? undefined).toBeUndefined();
      expect(after.settings?.comparison_key).toBe("metadata.case_id");
      expect(after.settings?.blind_reviews ?? undefined).toBeUndefined();

      yield* stack.destroy();
      yield* expectProjectGone(project.projectId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an explicitly named project keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = testName("alchemy-test-bt-project-a");
      const second = testName("alchemy-test-bt-project-b");

      const project = yield* stack.deploy(Braintrust.Project("Named", { name: first }));
      expect(project.name).toBe(first);

      const renamed = yield* stack.deploy(Braintrust.Project("Named", { name: second }));
      expect(renamed.projectId).toBe(project.projectId);
      expect(renamed.name).toBe(second);
      expect((yield* getProject(project.projectId)).name).toBe(second);
      yield* expectFound(Braintrust.Project.lookup({ name: second }), renamed);

      yield* stack.destroy();
      yield* expectProjectGone(project.projectId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a project with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-project");
      // POST returns the existing project of that name, so a leftover from
      // an interrupted run is reused rather than duplicated.
      const foreign = yield* braintrust.createProject({ name });

      const app = (allow: boolean) =>
        Braintrust.Project("Foreign", { name, description: "adopted" }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.projectId).toBe(foreign.id);
      expect((yield* getProject(foreign.id)).description).toBe("adopted");

      yield* stack.destroy();
      yield* expectProjectGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
