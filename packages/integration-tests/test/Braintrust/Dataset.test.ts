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

const tags = ["provider:braintrust", "provider:braintrust:dataset", "live"];

const getDataset = (datasetId: string) => braintrust.getDataset({ dataset_id: datasetId });

const expectDatasetGone = (datasetId: string) =>
  Effect.gen(function* () {
    const exists = yield* getDataset(datasetId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

const inProject = (props: Omit<Braintrust.DatasetProps, "projectId">) =>
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Project", {});
    return yield* Braintrust.Dataset("Dataset", { projectId: project.projectId, ...props });
  });

test.provider(
  "create a dataset, update and clear its fields in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const dataset = yield* stack.deploy(
        inProject({ description: "first", tags: ["a", "b"], metadata: { owner: "evals" } }),
      );
      const created = yield* getDataset(dataset.datasetId);
      expect(created.name).toBe(dataset.name);
      expect(created.project_id).toBe(dataset.projectId);
      expect(created.description).toBe("first");
      expect(created.tags).toEqual(["a", "b"]);
      expect(created.metadata).toEqual({ owner: "evals" });
      yield* expectFound(
        Braintrust.Dataset.lookup({ projectId: dataset.projectId, name: dataset.name }),
        dataset,
      );

      const plan = yield* stack.plan(
        inProject({ description: "first", tags: ["a", "b"], metadata: { owner: "evals" } }),
      );
      expect(plan.resources.Dataset.action).toBe("noop");

      const updated = yield* stack.deploy(
        inProject({ description: "second", tags: ["c"], metadata: { team: "support" } }),
      );
      expect(updated.datasetId).toBe(dataset.datasetId);
      yield* eventually(getDataset(dataset.datasetId), (observed) => {
        expect(observed.description).toBe("second");
        expect(observed.tags).toEqual(["c"]);
        // Metadata is replaced as a whole, not merged.
        expect(observed.metadata).toEqual({ team: "support" });
      });

      const cleared = yield* stack.deploy(inProject({}));
      expect(cleared.datasetId).toBe(dataset.datasetId);
      yield* eventually(getDataset(dataset.datasetId), (after) => {
        expect(after.description ?? undefined).toBeUndefined();
        expect(after.tags ?? []).toEqual([]);
        expect(after.metadata ?? undefined).toBeUndefined();
      });

      yield* stack.destroy();
      yield* expectDatasetGone(dataset.datasetId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "moving a dataset to another project replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both projects stay deployed across the replacement.
      const program = (target: "A" | "B") =>
        Effect.gen(function* () {
          const a = yield* Braintrust.Project("A", {});
          const b = yield* Braintrust.Project("B", {});
          return yield* Braintrust.Dataset("Moving", {
            projectId: target === "A" ? a.projectId : b.projectId,
          });
        });

      const first = yield* stack.deploy(program("A"));
      const moved = yield* stack.deploy(program("B"));
      expect(moved.datasetId).not.toBe(first.datasetId);
      expect(moved.projectId).not.toBe(first.projectId);
      yield* eventually(getDataset(moved.datasetId), (observed) => {
        expect(observed.project_id).toBe(moved.projectId);
      });
      yield* expectDatasetGone(first.datasetId);

      yield* stack.destroy();
      yield* expectDatasetGone(moved.datasetId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an explicitly named dataset keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const dataset = yield* stack.deploy(inProject({ name: testName("alchemy-test-bt-ds-a") }));
      const renamed = yield* stack.deploy(inProject({ name: testName("alchemy-test-bt-ds-b") }));
      expect(renamed.datasetId).toBe(dataset.datasetId);
      yield* eventually(getDataset(dataset.datasetId), (observed) => {
        expect(observed.name).toBe(testName("alchemy-test-bt-ds-b"));
      });

      yield* stack.destroy();
      yield* expectDatasetGone(dataset.datasetId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a dataset with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-ds");

      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      const foreign = yield* braintrust.createDataset({ project_id: project.projectId, name });

      const app = (allow: boolean) =>
        inProject({ name, description: "adopted" }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.datasetId).toBe(foreign.id);
      yield* eventually(getDataset(foreign.id), (observed) => {
        expect(observed.description).toBe("adopted");
      });

      yield* stack.destroy();
      yield* expectDatasetGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
