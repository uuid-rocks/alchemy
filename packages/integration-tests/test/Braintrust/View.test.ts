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

const tags = ["provider:braintrust", "provider:braintrust:view", "live"];

const getView = (view: { viewId: string; objectId: string }) =>
  braintrust.getView({ view_id: view.viewId, object_type: "project", object_id: view.objectId });

const expectViewGone = (view: { viewId: string; objectId: string }) =>
  Effect.gen(function* () {
    const exists = yield* getView(view).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

type Props = Omit<Braintrust.ViewProps, "objectType" | "objectId">;

const inProject = (props: Props) =>
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Project", {});
    return yield* Braintrust.View("View", {
      objectType: "project",
      objectId: project.projectId,
      ...props,
    });
  });

test.provider(
  "create a view, update and clear its fields in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first: Props = {
        viewType: "logs",
        description: "first",
        viewData: { search: { filter: ["error IS NOT NULL"] } },
        options: { columnOrder: ["input", "output"], rowHeight: "tall" },
      };
      const view = yield* stack.deploy(inProject(first));
      const created = yield* getView(view);
      expect(created.name).toBe(view.name);
      expect(created.object_id).toBe(view.objectId);
      expect(created.view_type).toBe("logs");
      expect(created.description).toBe("first");
      expect(created.view_data).toEqual({ search: { filter: ["error IS NOT NULL"] } });
      expect(created.options).toEqual({ columnOrder: ["input", "output"], rowHeight: "tall" });
      yield* expectFound(
        Braintrust.View.lookup({
          objectType: "project",
          objectId: view.objectId,
          viewType: "logs",
          name: view.name,
        }),
        view,
      );

      const plan = yield* stack.plan(inProject(first));
      expect(plan.resources.View.action).toBe("noop");

      // Changing the options replaces them whole and leaves the other
      // fields as deployed.
      yield* stack.deploy(inProject({ ...first, options: { rowHeight: "compact" } }));
      const afterOptions = yield* getView(view);
      expect(afterOptions.options).toEqual({ rowHeight: "compact" });
      expect(afterOptions.description).toBe("first");
      expect(afterOptions.view_data).toEqual({ search: { filter: ["error IS NOT NULL"] } });

      // The page a view applies to changes in place.
      const retyped = yield* stack.deploy(inProject({ ...first, viewType: "experiments" }));
      expect(retyped.viewId).toBe(view.viewId);
      yield* eventually(getView(view), (observed) => {
        expect(observed.view_type).toBe("experiments");
      });

      const cleared = yield* stack.deploy(inProject({ viewType: "experiments" }));
      expect(cleared.viewId).toBe(view.viewId);
      expect(cleared.description).toBeUndefined();
      expect(cleared.viewData).toBeUndefined();
      expect(cleared.options).toBeUndefined();
      yield* eventually(getView(view), (after) => {
        expect(after.description || undefined).toBeUndefined();
        expect(after.view_data ?? {}).toEqual({});
        expect(after.options ?? {}).toEqual({});
      });

      const replan = yield* stack.plan(inProject({ viewType: "experiments" }));
      expect(replan.resources.View.action).toBe("noop");

      yield* stack.destroy();
      yield* expectViewGone(view);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "moving a view to another project replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both projects stay deployed across the replacement.
      const program = (target: "A" | "B") =>
        Effect.gen(function* () {
          const a = yield* Braintrust.Project("A", {});
          const b = yield* Braintrust.Project("B", {});
          return yield* Braintrust.View("Moving", {
            objectType: "project",
            objectId: target === "A" ? a.projectId : b.projectId,
            viewType: "logs",
          });
        });

      const first = yield* stack.deploy(program("A"));
      const moved = yield* stack.deploy(program("B"));
      expect(moved.viewId).not.toBe(first.viewId);
      yield* eventually(getView(moved), (observed) => {
        expect(observed.object_id).toBe(moved.objectId);
      });
      yield* expectViewGone(first);

      yield* stack.destroy();
      yield* expectViewGone(moved);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an explicitly named view keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const view = yield* stack.deploy(
        inProject({ name: testName("alchemy-test-bt-view-a"), viewType: "logs" }),
      );
      const renamed = yield* stack.deploy(
        inProject({ name: testName("alchemy-test-bt-view-b"), viewType: "logs" }),
      );
      expect(renamed.viewId).toBe(view.viewId);
      yield* eventually(getView(view), (observed) => {
        expect(observed.name).toBe(testName("alchemy-test-bt-view-b"));
      });

      yield* stack.destroy();
      yield* expectViewGone(view);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a view with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-view");

      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      const foreign = yield* braintrust.createView({
        object_type: "project",
        object_id: project.projectId,
        view_type: "logs",
        name,
      });

      const app = (allow: boolean) =>
        inProject({ name, viewType: "logs", description: "adopted" }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.viewId).toBe(foreign.id);
      yield* eventually(getView(adopted), (observed) => {
        expect(observed.description).toBe("adopted");
      });

      yield* stack.destroy();
      yield* expectViewGone(adopted);
    }),
  { tags, timeout: 120_000 },
);
