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

const tags = ["provider:braintrust", "provider:braintrust:dataset-snapshot", "live"];

// Braintrust accepts any transaction id for a snapshot, and inserting
// records to get a real one needs log credits the test org lacks.
const V1 = "1000196022104685824";
const V2 = "1000196022104685900";

const getSnapshot = (datasetSnapshotId: string) =>
  braintrust.getDatasetSnapshot({ dataset_snapshot_id: datasetSnapshotId });

const expectSnapshotGone = (datasetSnapshotId: string) =>
  Effect.gen(function* () {
    const exists = yield* getSnapshot(datasetSnapshotId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

type Props = Omit<Braintrust.DatasetSnapshotProps, "datasetId">;

const inDataset = (props: Props) =>
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Project", {});
    const dataset = yield* Braintrust.Dataset("Dataset", { projectId: project.projectId });
    return yield* Braintrust.DatasetSnapshot("Snapshot", {
      datasetId: dataset.datasetId,
      ...props,
    });
  });

test.provider(
  "create a dataset snapshot, update and clear its description in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const snapshot = yield* stack.deploy(inDataset({ xactId: V1, description: "first" }));
      const created = yield* getSnapshot(snapshot.datasetSnapshotId);
      expect(created.name).toBe(snapshot.name);
      expect(created.dataset_id).toBe(snapshot.datasetId);
      expect(created.xact_id).toBe(V1);
      expect(created.description).toBe("first");
      yield* expectFound(
        Braintrust.DatasetSnapshot.lookup({ datasetId: snapshot.datasetId, name: snapshot.name }),
        snapshot,
      );

      const plan = yield* stack.plan(inDataset({ xactId: V1, description: "first" }));
      expect(plan.resources.Snapshot.action).toBe("noop");

      const updated = yield* stack.deploy(inDataset({ xactId: V1, description: "second" }));
      expect(updated.datasetSnapshotId).toBe(snapshot.datasetSnapshotId);
      yield* eventually(getSnapshot(snapshot.datasetSnapshotId), (observed) => {
        expect(observed.description).toBe("second");
        expect(observed.name).toBe(snapshot.name);
        expect(observed.xact_id).toBe(V1);
      });

      const cleared = yield* stack.deploy(inDataset({ xactId: V1 }));
      expect(cleared.datasetSnapshotId).toBe(snapshot.datasetSnapshotId);
      yield* eventually(getSnapshot(snapshot.datasetSnapshotId), (observed) => {
        expect(observed.description).toBeNull();
      });

      yield* stack.destroy();
      yield* expectSnapshotGone(snapshot.datasetSnapshotId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "pinning another version replaces an explicitly named snapshot under the same name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-snapshot-pin");

      const first = yield* stack.deploy(inDataset({ name, xactId: V1 }));
      const repinned = yield* stack.deploy(inDataset({ name, xactId: V2 }));
      expect(repinned.datasetSnapshotId).not.toBe(first.datasetSnapshotId);
      yield* eventually(getSnapshot(repinned.datasetSnapshotId), (observed) => {
        expect(observed.name).toBe(name);
        expect(observed.xact_id).toBe(V2);
      });
      yield* expectSnapshotGone(first.datasetSnapshotId);

      yield* stack.destroy();
      yield* expectSnapshotGone(repinned.datasetSnapshotId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "moving a snapshot to another dataset replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both datasets stay deployed across the replacement.
      const program = (target: "A" | "B") =>
        Effect.gen(function* () {
          const project = yield* Braintrust.Project("Project", {});
          const a = yield* Braintrust.Dataset("A", { projectId: project.projectId });
          const b = yield* Braintrust.Dataset("B", { projectId: project.projectId });
          return yield* Braintrust.DatasetSnapshot("Moving", {
            datasetId: target === "A" ? a.datasetId : b.datasetId,
            xactId: V1,
          });
        });

      const first = yield* stack.deploy(program("A"));
      const moved = yield* stack.deploy(program("B"));
      expect(moved.datasetSnapshotId).not.toBe(first.datasetSnapshotId);
      yield* eventually(getSnapshot(moved.datasetSnapshotId), (observed) => {
        expect(observed.dataset_id).toBe(moved.datasetId);
      });
      yield* expectSnapshotGone(first.datasetSnapshotId);

      yield* stack.destroy();
      yield* expectSnapshotGone(moved.datasetSnapshotId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an explicitly named snapshot keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const snapshot = yield* stack.deploy(
        inDataset({ name: testName("alchemy-test-bt-snapshot-a"), xactId: V1 }),
      );
      const renamed = yield* stack.deploy(
        inDataset({ name: testName("alchemy-test-bt-snapshot-b"), xactId: V1 }),
      );
      expect(renamed.datasetSnapshotId).toBe(snapshot.datasetSnapshotId);
      yield* eventually(getSnapshot(snapshot.datasetSnapshotId), (observed) => {
        expect(observed.name).toBe(testName("alchemy-test-bt-snapshot-b"));
      });

      yield* stack.destroy();
      yield* expectSnapshotGone(snapshot.datasetSnapshotId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a snapshot with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-snapshot");

      const dataset = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Braintrust.Project("Project", {});
          return yield* Braintrust.Dataset("Dataset", { projectId: project.projectId });
        }),
      );
      const foreign = yield* braintrust.createDatasetSnapshot({
        dataset_id: dataset.datasetId,
        name,
        xact_id: V1,
      });

      const app = (allow: boolean) =>
        inDataset({ name, xactId: V1, description: "adopted" }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.datasetSnapshotId).toBe(foreign.id);
      yield* eventually(getSnapshot(foreign.id), (observed) => {
        expect(observed.description).toBe("adopted");
      });

      yield* stack.destroy();
      yield* expectSnapshotGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
