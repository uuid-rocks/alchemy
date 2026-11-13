import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import type { Input, InputProps } from "alchemy/Input";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { testName } from "../names.ts";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:experiment", "live"];

const getExperiment = (experimentId: string) =>
  braintrust.getExperiment({ experiment_id: experimentId });

const expectExperimentGone = (experimentId: string) =>
  Effect.gen(function* () {
    const exists = yield* getExperiment(experimentId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

/** A project with two datasets and a baseline, and the experiment under test. */
const inProject = (
  props: (refs: {
    first: Input<string>;
    second: Input<string>;
    baseline: Input<string>;
  }) => InputProps<Omit<Braintrust.ExperimentProps, "projectId">>,
) =>
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Project", {});
    const first = yield* Braintrust.Dataset("First", { projectId: project.projectId });
    const second = yield* Braintrust.Dataset("Second", { projectId: project.projectId });
    const baseline = yield* Braintrust.Experiment("Baseline", { projectId: project.projectId });
    const experiment = yield* Braintrust.Experiment("Experiment", {
      projectId: project.projectId,
      ...props({
        first: first.datasetId,
        second: second.datasetId,
        baseline: baseline.experimentId,
      }),
    });
    return { experiment, first, second, baseline };
  });

test.provider(
  "create an experiment, update and clear its fields in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const initial = inProject(({ first }) => ({
        description: "first",
        tags: ["a"],
        metadata: { model: "small", params: { temperature: 0, top_p: 1 } },
        datasetId: first,
      }));
      const { experiment, first, second, baseline } = yield* stack.deploy(initial);
      const created = yield* getExperiment(experiment.experimentId);
      expect(created.name).toBe(experiment.name);
      expect(created.description).toBe("first");
      expect(created.public).toBe(false);
      expect(created.tags).toEqual(["a"]);
      expect(created.metadata).toEqual({ model: "small", params: { temperature: 0, top_p: 1 } });
      expect(created.dataset_id).toBe(first.datasetId);
      yield* expectFound(
        Braintrust.Experiment.lookup({ projectId: experiment.projectId, name: experiment.name }),
        experiment,
      );

      const plan = yield* stack.plan(initial);
      expect(plan.resources.Experiment.action).toBe("noop");

      // Rename, retag, flip public, merge metadata, and relink in place.
      const name = testName("alchemy-test-bt-experiment");
      const { experiment: updated } = yield* stack.deploy(
        inProject(({ second, baseline }) => ({
          name,
          description: "second",
          public: true,
          tags: ["b", "c"],
          metadata: { model: "large", params: { temperature: 0.5 } },
          baseExperimentId: baseline,
          datasetId: second,
        })),
      );
      expect(updated.experimentId).toBe(experiment.experimentId);
      expect(updated.name).toBe(name);
      expect(updated.metadata).toEqual({ model: "large", params: { temperature: 0.5 } });
      const observed = yield* getExperiment(experiment.experimentId);
      expect(observed.name).toBe(name);
      expect(observed.description).toBe("second");
      expect(observed.public).toBe(true);
      expect(observed.tags).toEqual(["b", "c"]);
      // A removed key stays as null: Braintrust merges experiment metadata.
      expect(observed.metadata).toEqual({
        model: "large",
        params: { temperature: 0.5, top_p: null },
      });
      expect(observed.base_exp_id).toBe(baseline.experimentId);
      expect(observed.dataset_id).toBe(second.datasetId);

      const { experiment: cleared } = yield* stack.deploy(
        inProject(({ second }) => ({ name, datasetId: second })),
      );
      expect(cleared.experimentId).toBe(experiment.experimentId);
      expect(cleared.metadata).toBeUndefined();
      const after = yield* getExperiment(experiment.experimentId);
      expect(after.description || undefined).toBeUndefined();
      expect(after.public).toBe(false);
      expect(after.tags ?? []).toEqual([]);
      expect(after.base_exp_id ?? undefined).toBeUndefined();

      yield* stack.destroy();
      yield* expectExperimentGone(experiment.experimentId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "unlinking the dataset or moving to another project replaces the experiment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both projects and the dataset stay deployed across the replacements.
      const program = (target: "A" | "B", linked: boolean) =>
        Effect.gen(function* () {
          const a = yield* Braintrust.Project("A", {});
          const b = yield* Braintrust.Project("B", {});
          const dataset = yield* Braintrust.Dataset("Dataset", { projectId: a.projectId });
          return yield* Braintrust.Experiment("Moving", {
            projectId: target === "A" ? a.projectId : b.projectId,
            datasetId: linked ? dataset.datasetId : undefined,
          });
        });

      const linked = yield* stack.deploy(program("A", true));
      expect(linked.datasetId).toBeTruthy();

      const unlinked = yield* stack.deploy(program("A", false));
      expect(unlinked.experimentId).not.toBe(linked.experimentId);
      expect(unlinked.datasetId).toBeUndefined();
      yield* expectExperimentGone(linked.experimentId);

      const moved = yield* stack.deploy(program("B", false));
      expect(moved.experimentId).not.toBe(unlinked.experimentId);
      expect((yield* getExperiment(moved.experimentId)).project_id).toBe(moved.projectId);
      yield* expectExperimentGone(unlinked.experimentId);

      yield* stack.destroy();
      yield* expectExperimentGone(moved.experimentId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "an experiment with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-experiment");

      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      const foreign = yield* braintrust.createExperiment({
        project_id: project.projectId,
        name,
      });

      const app = (allow: boolean) =>
        Effect.gen(function* () {
          const project = yield* Braintrust.Project("Project", {});
          return yield* Braintrust.Experiment("Foreign", {
            projectId: project.projectId,
            name,
            description: "adopted",
          });
        }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.experimentId).toBe(foreign.id);
      expect((yield* getExperiment(foreign.id)).description).toBe("adopted");

      yield* stack.destroy();
      yield* expectExperimentGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
