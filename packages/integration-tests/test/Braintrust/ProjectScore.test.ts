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

const tags = ["provider:braintrust", "provider:braintrust:project-score", "live"];

const getScore = (projectScoreId: string) =>
  braintrust.getProjectScore({ project_score_id: projectScoreId });

const expectScoreGone = (projectScoreId: string) =>
  Effect.gen(function* () {
    const exists = yield* getScore(projectScoreId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

const inProject = (props: Omit<Braintrust.ProjectScoreProps, "projectId">) =>
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Project", {});
    return yield* Braintrust.ProjectScore("Score", { projectId: project.projectId, ...props });
  });

test.provider(
  "create a project score, update and clear its fields in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first: Omit<Braintrust.ProjectScoreProps, "projectId"> = {
        scoreType: "categorical",
        description: "first",
        categories: [
          { name: "good", value: 1 },
          { name: "bad", value: 0 },
        ],
        config: { multi_select: true, destination: "expected" },
      };
      const score = yield* stack.deploy(inProject(first));
      const created = yield* getScore(score.projectScoreId);
      expect(created.name).toBe(score.name);
      expect(created.project_id).toBe(score.projectId);
      expect(created.score_type).toBe("categorical");
      expect(created.description).toBe("first");
      expect(created.categories).toEqual(first.categories);
      expect(created.config).toEqual({ multi_select: true, destination: "expected" });
      yield* expectFound(
        Braintrust.ProjectScore.lookup({ projectId: score.projectId, name: score.name }),
        score,
      );

      const plan = yield* stack.plan(inProject(first));
      expect(plan.resources.Score.action).toBe("noop");

      // Changing the categories leaves the other fields as deployed.
      const recategorized = yield* stack.deploy(
        inProject({ ...first, categories: [{ name: "pass", value: 1 }] }),
      );
      expect(recategorized.projectScoreId).toBe(score.projectScoreId);
      const afterCategories = yield* getScore(score.projectScoreId);
      expect(afterCategories.categories).toEqual([{ name: "pass", value: 1 }]);
      expect(afterCategories.description).toBe("first");
      expect(afterCategories.config).toEqual({ multi_select: true, destination: "expected" });

      // The config is replaced as a whole, not merged.
      yield* stack.deploy(inProject({ ...first, config: { destination: "metadata" } }));
      yield* eventually(getScore(score.projectScoreId), (observed) => {
        expect(observed.config).toEqual({ destination: "metadata" });
      });

      const cleared = yield* stack.deploy(inProject({ scoreType: "slider" }));
      expect(cleared.projectScoreId).toBe(score.projectScoreId);
      expect(cleared.scoreType).toBe("slider");
      expect(cleared.description).toBeUndefined();
      expect(cleared.categories).toBeUndefined();
      expect(cleared.config).toBeUndefined();
      yield* eventually(getScore(score.projectScoreId), (after) => {
        expect(after.score_type).toBe("slider");
        expect(after.description || undefined).toBeUndefined();
        expect(after.categories ?? []).toEqual([]);
        expect(after.config ?? {}).toEqual({});
      });

      const replan = yield* stack.plan(inProject({ scoreType: "slider" }));
      expect(replan.resources.Score.action).toBe("noop");

      yield* stack.destroy();
      yield* expectScoreGone(score.projectScoreId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a weighted score's weights can be cleared",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const score = yield* stack.deploy(
        inProject({ scoreType: "weighted", categories: { accuracy: 2, tone: 1 } }),
      );
      yield* eventually(getScore(score.projectScoreId), (observed) => {
        expect(observed.categories).toEqual({ accuracy: 2, tone: 1 });
      });

      const cleared = yield* stack.deploy(inProject({ scoreType: "weighted" }));
      expect(cleared.projectScoreId).toBe(score.projectScoreId);
      expect(cleared.categories).toBeUndefined();
      yield* eventually(getScore(score.projectScoreId), (observed) => {
        expect(observed.categories ?? {}).toEqual({});
      });

      yield* stack.destroy();
      yield* expectScoreGone(score.projectScoreId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "moving a project score to another project replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both projects stay deployed across the replacement.
      const program = (target: "A" | "B") =>
        Effect.gen(function* () {
          const a = yield* Braintrust.Project("A", {});
          const b = yield* Braintrust.Project("B", {});
          return yield* Braintrust.ProjectScore("Moving", {
            projectId: target === "A" ? a.projectId : b.projectId,
            scoreType: "slider",
          });
        });

      const first = yield* stack.deploy(program("A"));
      const moved = yield* stack.deploy(program("B"));
      expect(moved.projectScoreId).not.toBe(first.projectScoreId);
      yield* eventually(getScore(moved.projectScoreId), (observed) => {
        expect(observed.project_id).toBe(moved.projectId);
      });
      yield* expectScoreGone(first.projectScoreId);

      yield* stack.destroy();
      yield* expectScoreGone(moved.projectScoreId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an explicitly named project score keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const score = yield* stack.deploy(
        inProject({ name: testName("alchemy-test-bt-score-a"), scoreType: "slider" }),
      );
      const renamed = yield* stack.deploy(
        inProject({ name: testName("alchemy-test-bt-score-b"), scoreType: "slider" }),
      );
      expect(renamed.projectScoreId).toBe(score.projectScoreId);
      yield* eventually(getScore(score.projectScoreId), (observed) => {
        expect(observed.name).toBe(testName("alchemy-test-bt-score-b"));
      });

      yield* stack.destroy();
      yield* expectScoreGone(score.projectScoreId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a project score with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-score");

      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      const foreign = yield* braintrust.createProjectScore({
        project_id: project.projectId,
        name,
        score_type: "slider",
      });

      const app = (allow: boolean) =>
        inProject({ name, scoreType: "slider", description: "adopted" }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.projectScoreId).toBe(foreign.id);
      yield* eventually(getScore(foreign.id), (observed) => {
        expect(observed.description).toBe("adopted");
      });

      yield* stack.destroy();
      yield* expectScoreGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
