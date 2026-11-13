import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { testName } from "../names.ts";
import { eventually, expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:function", "live"];

const getFunction = (functionId: string) => braintrust.getFunction({ function_id: functionId });

const expectFunctionGone = (functionId: string) =>
  Effect.gen(function* () {
    const exists = yield* getFunction(functionId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

const inlineCode = (code: string): Braintrust.InlineCodeFunctionData => ({
  type: "code",
  data: { type: "inline", runtime_context: { runtime: "node", version: "20" }, code },
});

const exactMatch = inlineCode(
  "function handler({ output, expected }) { return output === expected ? 1 : 0; }",
);
const caseInsensitive = inlineCode(
  "function handler({ output, expected }) { return output.toLowerCase() === expected.toLowerCase() ? 1 : 0; }",
);

const inProject = (props: Omit<Braintrust.FunctionProps, "projectId">) =>
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Project", {});
    return yield* Braintrust.Function("Function", { projectId: project.projectId, ...props });
  });

test.provider(
  "create an inline code scorer, write a version only when it changes, clear its fields, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first: Omit<Braintrust.FunctionProps, "projectId"> = {
        functionType: "scorer",
        functionData: exactMatch,
        description: "first",
        tags: ["a", "b"],
        functionSchema: { returns: { type: "number" } },
      };
      const fn = yield* stack.deploy(inProject(first));
      yield* eventually(getFunction(fn.functionId), (created) => {
        expect(created.slug).toBe(fn.slug);
        expect(created.name).toBe(fn.slug);
        expect(created.project_id).toBe(fn.projectId);
        expect(created.function_type).toBe("scorer");
        expect(created.function_data).toMatchObject(exactMatch);
        expect(created.description).toBe("first");
        expect(created.tags).toEqual(["a", "b"]);
        expect(created.function_schema).toEqual({ returns: { type: "number" } });
      });
      yield* expectFound(
        Braintrust.Function.lookup({ projectId: fn.projectId, slug: fn.slug }),
        fn,
      );

      const plan = yield* stack.plan(inProject(first));
      expect(plan.resources.Function.action).toBe("noop");

      // A forced redeploy runs reconcile against an unchanged function; a
      // write would append a version.
      const forced = yield* stack.deploy(inProject(first), { force: true });
      expect(forced.functionId).toBe(fn.functionId);
      expect(forced.version).toBe(fn.version);

      // Changing the code leaves the other fields as deployed.
      const recoded = yield* stack.deploy(inProject({ ...first, functionData: caseInsensitive }));
      expect(recoded.functionId).toBe(fn.functionId);
      expect(recoded.version).not.toBe(fn.version);
      yield* eventually(getFunction(fn.functionId), (observed) => {
        expect(observed.function_data).toMatchObject(caseInsensitive);
        expect(observed.function_type).toBe("scorer");
        expect(observed.description).toBe("first");
        expect(observed.tags).toEqual(["a", "b"]);
        expect(observed.function_schema).toEqual({ returns: { type: "number" } });
      });

      const cleared = yield* stack.deploy(
        inProject({ functionType: "scorer", functionData: caseInsensitive }),
      );
      expect(cleared.functionId).toBe(fn.functionId);
      yield* eventually(getFunction(fn.functionId), (after) => {
        expect(after.description || undefined).toBeUndefined();
        expect(after.tags ?? []).toEqual([]);
        expect(after.function_schema ?? undefined).toBeUndefined();
      });

      yield* stack.destroy();
      yield* expectFunctionGone(fn.functionId);
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a function can switch from inline code to a built-in scorer in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const code = yield* stack.deploy(
        inProject({ functionType: "scorer", functionData: exactMatch }),
      );
      const global = yield* stack.deploy(
        inProject({ functionType: "scorer", functionData: { type: "global", name: "ExactMatch" } }),
      );
      expect(global.functionId).toBe(code.functionId);
      yield* eventually(getFunction(code.functionId), (observed) => {
        expect(observed.function_data).toMatchObject({ type: "global", name: "ExactMatch" });
      });

      const plan = yield* stack.plan(
        inProject({ functionType: "scorer", functionData: { type: "global", name: "ExactMatch" } }),
      );
      expect(plan.resources.Function.action).toBe("noop");

      yield* stack.destroy();
      yield* expectFunctionGone(code.functionId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "moving a function to another project replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both projects stay deployed across the replacement.
      const program = (target: "A" | "B") =>
        Effect.gen(function* () {
          const a = yield* Braintrust.Project("A", {});
          const b = yield* Braintrust.Project("B", {});
          return yield* Braintrust.Function("Moving", {
            projectId: target === "A" ? a.projectId : b.projectId,
            functionData: exactMatch,
          });
        });

      const first = yield* stack.deploy(program("A"));
      const moved = yield* stack.deploy(program("B"));
      expect(moved.functionId).not.toBe(first.functionId);
      expect(moved.projectId).not.toBe(first.projectId);
      yield* eventually(getFunction(moved.functionId), (observed) => {
        expect(observed.project_id).toBe(moved.projectId);
      });
      yield* expectFunctionGone(first.functionId);

      yield* stack.destroy();
      yield* expectFunctionGone(moved.functionId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "changing the slug of a function replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const before = testName("alchemy-test-bt-fn-a");
      const after = testName("alchemy-test-bt-fn-b");

      const fn = yield* stack.deploy(inProject({ slug: before, functionData: exactMatch }));
      expect(fn.slug).toBe(before);
      const moved = yield* stack.deploy(inProject({ slug: after, functionData: exactMatch }));
      expect(moved.functionId).not.toBe(fn.functionId);
      expect(moved.slug).toBe(after);
      yield* eventually(getFunction(moved.functionId), (observed) => {
        expect(observed.slug).toBe(after);
      });
      yield* expectFunctionGone(fn.functionId);

      yield* stack.destroy();
      yield* expectFunctionGone(moved.functionId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a function with an explicit slug created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const slug = testName("alchemy-test-bt-foreign-fn");

      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      const foreign = yield* braintrust.createFunction({
        project_id: project.projectId,
        name: slug,
        slug,
        function_data: exactMatch,
      });

      const app = (allow: boolean) =>
        inProject({ slug, functionData: caseInsensitive }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.functionId).toBe(foreign.id);
      yield* eventually(getFunction(foreign.id), (observed) => {
        expect(observed.function_data).toMatchObject(caseInsensitive);
      });

      yield* stack.destroy();
      yield* expectFunctionGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a function that doesn't exist reads as gone, deletes cleanly, and fails a lookup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      const missing = "00000000-0000-4000-8000-000000000000";

      // The tag the provider's read and delete treat as gone.
      const read = yield* getFunction(missing).pipe(Effect.flip);
      expect(read._tag).toBe("NotFoundOrForbidden");
      const deleted = yield* braintrust.deleteFunction({ function_id: missing }).pipe(Effect.flip);
      expect(deleted._tag).toBe("NotFoundOrForbidden");

      const lookup = Braintrust.Function.lookup({
        projectId: project.projectId,
        slug: "alchemy-test-bt-missing-fn",
      });
      const probe = Core.scratchStack(
        { providers: Braintrust.providers() },
        "BraintrustLookupProbe",
      );
      const lookupMissed = yield* probe
        .plan(
          Braintrust.Project("lookup-probe", {
            // Resolving the attribute runs the lookup.
            description: lookup.functionId,
          }),
        )
        .pipe(
          Effect.map(() => false),
          Effect.catchDefect((defect) =>
            Predicate.isTagged(defect, "LookupNotFoundError")
              ? Effect.succeed(true)
              : Effect.die(defect),
          ),
        );
      expect(lookupMissed).toBe(true);

      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
