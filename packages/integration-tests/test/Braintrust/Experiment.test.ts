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
import { eventually, expectFound } from "./lookup.ts";

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
      yield* eventually(getExperiment(experiment.experimentId), (observed) => {
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
      });

      const { experiment: cleared } = yield* stack.deploy(
        inProject(({ second }) => ({ name, datasetId: second })),
      );
      expect(cleared.experimentId).toBe(experiment.experimentId);
      expect(cleared.metadata).toBeUndefined();
      yield* eventually(getExperiment(experiment.experimentId), (after) => {
        expect(after.description || undefined).toBeUndefined();
        expect(after.public).toBe(false);
        expect(after.tags ?? []).toEqual([]);
        expect(after.base_exp_id ?? undefined).toBeUndefined();
      });

      yield* stack.destroy();
      yield* expectExperimentGone(experiment.experimentId);
    }),
  { tags, timeout: 120_000 },
);

/** Saved parameters, as `braintrust push` makes them. */
const createParameters = (projectId: string, slug: string) =>
  braintrust.createFunction({
    project_id: projectId,
    name: slug,
    slug,
    function_type: "parameters",
    function_data: {
      type: "parameters",
      data: {},
      __schema: { type: "object", properties: { model: { type: "string" } } },
    },
  });

test.provider(
  "pin the dataset version, saved parameters and repo info, change and clear them in place, and replace on unlinking the parameters",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project, dataset } = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Braintrust.Project("Project", {});
          const dataset = yield* Braintrust.Dataset("Dataset", { projectId: project.projectId });
          return { project, dataset };
        }),
      );
      // Parameters are deleted with the project on destroy.
      const first = yield* createParameters(
        project.projectId,
        testName("alchemy-test-bt-params-a"),
      );
      const second = yield* createParameters(
        project.projectId,
        testName("alchemy-test-bt-params-b"),
      );

      const program = (props: Omit<Braintrust.ExperimentProps, "projectId" | "datasetId">) =>
        Effect.gen(function* () {
          const project = yield* Braintrust.Project("Project", {});
          yield* Braintrust.Dataset("Dataset", { projectId: project.projectId });
          return yield* Braintrust.Experiment("Pinned", {
            projectId: project.projectId,
            datasetId: dataset.datasetId,
            ...props,
          });
        });

      const pinned = program({
        datasetVersion: "1000000000000000001",
        parametersId: first.id,
        parametersVersion: first._xact_id,
        repoInfo: { commit: "abc", branch: "main", dirty: false },
      });
      const experiment = yield* stack.deploy(pinned);
      expect(experiment.repoInfo).toEqual({ commit: "abc", branch: "main", dirty: false });
      yield* eventually(getExperiment(experiment.experimentId), (created) => {
        expect(created.dataset_version).toBe("1000000000000000001");
        expect(created.parameters_id).toBe(first.id);
        expect(created.parameters_version).toBe(first._xact_id);
        expect(created.repo_info).toEqual({ commit: "abc", branch: "main", dirty: false });
      });
      const plan = yield* stack.plan(pinned);
      expect(plan.resources.Pinned.action).toBe("noop");

      const changed = yield* stack.deploy(
        program({
          datasetVersion: "1000000000000000002",
          parametersId: second.id,
          parametersVersion: second._xact_id,
          repoInfo: { commit: "def", tag: "v1" },
        }),
      );
      expect(changed.experimentId).toBe(experiment.experimentId);
      expect(changed.repoInfo).toEqual({ commit: "def", tag: "v1" });
      yield* eventually(getExperiment(experiment.experimentId), (observed) => {
        expect(observed.dataset_version).toBe("1000000000000000002");
        expect(observed.parameters_id).toBe(second.id);
        expect(observed.parameters_version).toBe(second._xact_id);
        // Repo info merges like metadata: removed keys stay as null.
        expect(observed.repo_info).toEqual({ commit: "def", branch: null, tag: "v1", dirty: null });
      });

      const cleared = yield* stack.deploy(program({ parametersId: second.id }));
      expect(cleared.experimentId).toBe(experiment.experimentId);
      expect(cleared.datasetVersion).toBeUndefined();
      expect(cleared.parametersVersion).toBeUndefined();
      expect(cleared.repoInfo).toBeUndefined();
      yield* eventually(getExperiment(experiment.experimentId), (after) => {
        expect(after.dataset_version || undefined).toBeUndefined();
        expect(after.parameters_version || undefined).toBeUndefined();
        expect(after.parameters_id).toBe(second.id);
      });

      // Braintrust can't unlink parameters, so removing them replaces.
      const unlinked = yield* stack.deploy(program({}));
      expect(unlinked.experimentId).not.toBe(experiment.experimentId);
      expect(unlinked.parametersId).toBeUndefined();
      yield* expectExperimentGone(experiment.experimentId);

      yield* stack.destroy();
      yield* expectExperimentGone(unlinked.experimentId);
    }),
  { tags, timeout: 180_000 },
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
      yield* eventually(getExperiment(moved.experimentId), (observed) => {
        expect(observed.project_id).toBe(moved.projectId);
      });
      yield* expectExperimentGone(unlinked.experimentId);

      yield* stack.destroy();
      yield* expectExperimentGone(moved.experimentId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "unlinking the dataset of an explicitly named experiment replaces it under the same name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-unlinked-experiment");

      const program = (linked: boolean) =>
        Effect.gen(function* () {
          const project = yield* Braintrust.Project("Project", {});
          const dataset = yield* Braintrust.Dataset("Dataset", { projectId: project.projectId });
          return yield* Braintrust.Experiment("Experiment", {
            projectId: project.projectId,
            name,
            datasetId: linked ? dataset.datasetId : undefined,
          });
        });

      const linked = yield* stack.deploy(program(true));
      const unlinked = yield* stack.deploy(program(false));
      expect(unlinked.experimentId).not.toBe(linked.experimentId);
      yield* expectExperimentGone(linked.experimentId);
      yield* eventually(getExperiment(unlinked.experimentId), (observed) => {
        expect(observed.name).toBe(name);
        expect(observed.dataset_id ?? undefined).toBeUndefined();
      });

      yield* stack.destroy();
      yield* expectExperimentGone(unlinked.experimentId);
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
      yield* eventually(getExperiment(foreign.id), (observed) => {
        expect(observed.description).toBe("adopted");
      });

      yield* stack.destroy();
      yield* expectExperimentGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
