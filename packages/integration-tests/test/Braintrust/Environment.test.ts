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

const tags = ["provider:braintrust", "provider:braintrust:environment", "live"];

const getEnvironment = (environmentId: string) =>
  braintrust.getEnvironment({ environment_id: environmentId });

const expectEnvironmentGone = (environmentId: string) =>
  Effect.gen(function* () {
    const exists = yield* getEnvironment(environmentId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

test.provider(
  "create an environment, update and clear its fields in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const environment = yield* stack.deploy(
        Braintrust.Environment("Environment", { name: "Staging", description: "first" }),
      );
      const created = yield* getEnvironment(environment.environmentId);
      expect(created.slug).toBe(environment.slug);
      expect(created.name).toBe("Staging");
      expect(created.description).toBe("first");
      yield* expectFound(Braintrust.Environment.lookup({ slug: environment.slug }), environment);

      const plan = yield* stack.plan(
        Braintrust.Environment("Environment", { name: "Staging", description: "first" }),
      );
      expect(plan.resources.Environment.action).toBe("noop");

      // Changing only the description leaves the name and slug alone.
      const updated = yield* stack.deploy(
        Braintrust.Environment("Environment", { name: "Staging", description: "second" }),
      );
      expect(updated.environmentId).toBe(environment.environmentId);
      yield* eventually(getEnvironment(environment.environmentId), (observed) => {
        expect(observed.description).toBe("second");
        expect(observed.name).toBe("Staging");
        expect(observed.slug).toBe(environment.slug);
      });

      // Without a name, the name falls back to the slug.
      const cleared = yield* stack.deploy(Braintrust.Environment("Environment", {}));
      expect(cleared.environmentId).toBe(environment.environmentId);
      yield* eventually(getEnvironment(environment.environmentId), (after) => {
        expect(after.name).toBe(environment.slug);
        expect(after.description ?? undefined).toBeUndefined();
      });

      yield* stack.destroy();
      yield* expectEnvironmentGone(environment.environmentId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "changing an explicit slug keeps the environment's id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const environment = yield* stack.deploy(
        Braintrust.Environment("Environment", { slug: testName("alchemy-test-bt-env-a") }),
      );
      const renamed = yield* stack.deploy(
        Braintrust.Environment("Environment", { slug: testName("alchemy-test-bt-env-b") }),
      );
      expect(renamed.environmentId).toBe(environment.environmentId);
      yield* eventually(getEnvironment(environment.environmentId), (observed) => {
        expect(observed.slug).toBe(testName("alchemy-test-bt-env-b"));
      });

      yield* stack.destroy();
      yield* expectEnvironmentGone(environment.environmentId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "an environment with an explicit slug created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const slug = testName("alchemy-test-bt-foreign-env");

      const foreign = yield* braintrust.createEnvironment({ name: "Foreign", slug });

      const app = (allow: boolean) =>
        Braintrust.Environment("Foreign", { slug, description: "adopted" }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.environmentId).toBe(foreign.id);
      yield* eventually(getEnvironment(foreign.id), (observed) => {
        expect(observed.description).toBe("adopted");
        expect(observed.name).toBe(slug);
      });

      yield* stack.destroy();
      yield* expectEnvironmentGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
