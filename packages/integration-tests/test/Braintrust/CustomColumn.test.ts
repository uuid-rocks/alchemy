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

const tags = ["provider:braintrust", "provider:braintrust:custom-column", "live"];

// Columns have no get by id; they are read from their table's list. That
// list refuses a deleted project, so each case checks deletion with the
// project still deployed.
const findColumn = (column: Braintrust.CustomColumnAttributes) =>
  braintrust
    .listColumns({
      object_type: column.objectType,
      object_id: column.objectId,
      subtype: column.subtype,
      variant: column.variant,
    })
    .pipe(Effect.map(({ objects }) => objects.find((c) => c.id === column.customColumnId)));

const getColumn = (column: Braintrust.CustomColumnAttributes) =>
  findColumn(column).pipe(
    Effect.tap((found) => Effect.sync(() => expect(found).toBeDefined())),
    Effect.map((found) => found!),
  );

const expectColumnGone = (column: Braintrust.CustomColumnAttributes) =>
  Effect.gen(function* () {
    const found = yield* findColumn(column).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (found) => found === undefined,
        times: 10,
      }),
    );
    expect(found).toBeUndefined();
  });

type Props = Omit<Braintrust.CustomColumnProps, "objectType" | "objectId" | "subtype">;

const onLogs = (props: Props) =>
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Project", {});
    return yield* Braintrust.CustomColumn("Column", {
      objectType: "project",
      objectId: project.projectId,
      subtype: "project_log",
      ...props,
    });
  });

test.provider(
  "create a custom column, update it in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const column = yield* stack.deploy(onLogs({ expr: "metadata.model" }));
      expect(column.variant).toBe("project_log");
      const created = yield* getColumn(column);
      expect(created.name).toBe(column.name);
      expect(created.expr).toBe("metadata.model");
      yield* expectFound(
        Braintrust.CustomColumn.lookup({
          objectType: "project",
          objectId: column.objectId,
          subtype: "project_log",
          name: column.name,
        }),
        column,
      );

      const plan = yield* stack.plan(onLogs({ expr: "metadata.model" }));
      expect(plan.resources.Column.action).toBe("noop");

      // Spelling out the variant Braintrust defaulted to keeps the column.
      const explicit = yield* stack.deploy(
        onLogs({ expr: "metadata.model", variant: "project_log" }),
      );
      expect(explicit.customColumnId).toBe(column.customColumnId);

      const updated = yield* stack.deploy(
        onLogs({ expr: "metadata.provider", variant: "project_log" }),
      );
      expect(updated.customColumnId).toBe(column.customColumnId);
      yield* eventually(getColumn(column), (after) => {
        expect(after.expr).toBe("metadata.provider");
        expect(after.name).toBe(column.name);
      });

      yield* stack.deploy(Braintrust.Project("Project", {}));
      yield* expectColumnGone(column);
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "moving a custom column to another table replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (variant: "experiment" | "experiment_list") =>
        Effect.gen(function* () {
          const project = yield* Braintrust.Project("Project", {});
          return yield* Braintrust.CustomColumn("Moving", {
            objectType: "project",
            objectId: project.projectId,
            subtype: "experiment",
            variant,
            expr: "metadata.commit",
          });
        });

      const first = yield* stack.deploy(program("experiment"));
      const moved = yield* stack.deploy(program("experiment_list"));
      expect(moved.customColumnId).not.toBe(first.customColumnId);
      yield* eventually(getColumn(moved), (observed) => {
        expect(observed.variant).toBe("experiment_list");
      });
      yield* expectColumnGone(first);

      yield* stack.deploy(Braintrust.Project("Project", {}));
      yield* expectColumnGone(moved);
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an explicitly named custom column keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const expr = "metadata.model";

      const column = yield* stack.deploy(
        onLogs({ name: testName("alchemy-test-bt-column-a"), expr }),
      );
      const renamed = yield* stack.deploy(
        onLogs({ name: testName("alchemy-test-bt-column-b"), expr }),
      );
      expect(renamed.customColumnId).toBe(column.customColumnId);
      yield* eventually(getColumn(column), (after) => {
        expect(after.name).toBe(testName("alchemy-test-bt-column-b"));
        expect(after.expr).toBe(expr);
      });

      yield* stack.deploy(Braintrust.Project("Project", {}));
      yield* expectColumnGone(column);
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a custom column with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-column");

      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      const foreign = yield* braintrust.createColumn({
        object_type: "project",
        object_id: project.projectId,
        subtype: "project_log",
        name,
        expr: "metadata.foreign",
      });

      const app = (allow: boolean) => onLogs({ name, expr: "metadata.adopted" }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.customColumnId).toBe(foreign.id);
      yield* eventually(getColumn(adopted), (observed) => {
        expect(observed.expr).toBe("metadata.adopted");
      });

      yield* stack.deploy(Braintrust.Project("Project", {}));
      yield* expectColumnGone(adopted);
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
