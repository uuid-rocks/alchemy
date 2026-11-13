import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Drift from "alchemy/Drift";
import type { InputProps } from "alchemy/Input";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { eventually, expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:env-var", "live"];

const first = "sk-test-alchemy-first-11111";
const second = "sk-test-alchemy-second-22222";

const getEnvVar = (envVarId: string) => braintrust.getEnvVar({ env_var_id: envVarId });

const expectEnvVarGone = (envVarId: string) =>
  Effect.gen(function* () {
    const exists = yield* getEnvVar(envVarId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

/**
 * A read by id previews the stored value as its first and last five
 * characters, which is how a test can tell which value Braintrust holds.
 */
const expectStoredValue = Effect.fn(function* (envVarId: string, value: string) {
  const { preview_secret } = yield* getEnvVar(envVarId);
  const preview = Redacted.isRedacted(preview_secret) ? Redacted.value(preview_secret) : "";
  expect(preview.startsWith(value.slice(0, 5))).toBe(true);
  expect(preview.endsWith(value.slice(-5))).toBe(true);
});

const inProject = (props: InputProps<Omit<Braintrust.EnvVarProps, "objectType" | "objectId">>) =>
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Project", {});
    return yield* Braintrust.EnvVar("EnvVar", {
      objectType: "project",
      objectId: project.projectId,
      ...props,
    });
  });

test.provider(
  "create a variable, rotate its value, update and clear its fields in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const props = {
        name: "ALCHEMY_TEST_KEY",
        value: Redacted.make(first),
        metadata: { owner: "evals" },
        secretType: "openai",
      };
      const envVar = yield* stack.deploy(inProject(props));
      const created = yield* getEnvVar(envVar.envVarId);
      expect(created.object_type).toBe("project");
      expect(created.object_id).toBe(envVar.objectId);
      expect(created.name).toBe("ALCHEMY_TEST_KEY");
      expect(created.metadata).toEqual({ owner: "evals" });
      expect(created.secret_type).toBe("openai");
      yield* expectStoredValue(envVar.envVarId, first);
      // Only the masked preview is an attribute, and it stays Redacted.
      expect(Redacted.isRedacted(envVar.previewSecret)).toBe(true);
      expect(JSON.stringify(envVar)).not.toContain(first);
      yield* expectFound(
        Braintrust.EnvVar.lookup({
          objectType: "project",
          objectId: envVar.objectId,
          name: "ALCHEMY_TEST_KEY",
        }),
        envVar,
      );

      const plan = yield* stack.plan(inProject(props));
      expect(plan.resources.EnvVar.action).toBe("noop");

      // Rotating the value leaves the neighbouring fields alone.
      const rotated = yield* stack.deploy(inProject({ ...props, value: Redacted.make(second) }));
      expect(rotated.envVarId).toBe(envVar.envVarId);
      expect(rotated.secretUpdatedAt).not.toBe(envVar.secretUpdatedAt);
      yield* expectStoredValue(envVar.envVarId, second);
      const afterRotate = yield* getEnvVar(envVar.envVarId);
      expect(afterRotate.metadata).toEqual({ owner: "evals" });
      expect(afterRotate.secret_type).toBe("openai");

      // Rename and clear metadata and the classification.
      const cleared = yield* stack.deploy(
        inProject({ name: "ALCHEMY_TEST_KEY_2", value: Redacted.make(second) }),
      );
      expect(cleared.envVarId).toBe(envVar.envVarId);
      yield* eventually(getEnvVar(envVar.envVarId), (after) => {
        expect(after.name).toBe("ALCHEMY_TEST_KEY_2");
        expect(after.metadata ?? undefined).toBeUndefined();
        expect(after.secret_type ?? undefined).toBeUndefined();
      });
      yield* expectStoredValue(envVar.envVarId, second);

      yield* stack.destroy();
      yield* expectEnvVarGone(envVar.envVarId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a value rotated outside Alchemy is detected as drift and repaired",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const target = { name: stack.name, stage: stack.stage };

      const envVar = yield* stack.deploy(
        inProject({ name: "ALCHEMY_TEST_DRIFT", value: Redacted.make(first) }),
      );
      const clean = yield* Drift.detect(target).pipe(Effect.provide(stack.state));
      expect(clean.resources.EnvVar?.action).toBe("unchanged");

      yield* braintrust.updateEnvVar({
        env_var_id: envVar.envVarId,
        name: "ALCHEMY_TEST_DRIFT",
        value: Redacted.make("sk-test-outside-99999"),
      });
      yield* expectStoredValue(envVar.envVarId, "sk-test-outside-99999");

      const repaired = yield* Drift.repair(target).pipe(Effect.provide(stack.state));
      expect(repaired.resources.EnvVar?.action).toBe("repaired");
      yield* expectStoredValue(envVar.envVarId, first);

      yield* stack.destroy();
      yield* expectEnvVarGone(envVar.envVarId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "moving a variable to another project replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both projects stay deployed across the replacement.
      const program = (target: "A" | "B") =>
        Effect.gen(function* () {
          const a = yield* Braintrust.Project("A", {});
          const b = yield* Braintrust.Project("B", {});
          return yield* Braintrust.EnvVar("Moving", {
            objectType: "project",
            objectId: target === "A" ? a.projectId : b.projectId,
            name: "ALCHEMY_TEST_MOVING",
            value: Redacted.make(first),
          });
        });

      const before = yield* stack.deploy(program("A"));
      const moved = yield* stack.deploy(program("B"));
      expect(moved.envVarId).not.toBe(before.envVarId);
      expect(moved.objectId).not.toBe(before.objectId);
      yield* eventually(getEnvVar(moved.envVarId), (observed) => {
        expect(observed.object_id).toBe(moved.objectId);
      });
      yield* expectStoredValue(moved.envVarId, first);
      yield* expectEnvVarGone(before.envVarId);

      yield* stack.destroy();
      yield* expectEnvVarGone(moved.envVarId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a variable outlives its deleted project and is still deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const envVar = yield* stack.deploy(
        inProject({ name: "ALCHEMY_TEST_ORPHAN", value: Redacted.make(first) }),
      );
      yield* braintrust.deleteProject({ project_id: envVar.objectId });
      // Braintrust keeps the variable of a deleted project.
      yield* eventually(getEnvVar(envVar.envVarId), (observed) => {
        expect(observed.id).toBe(envVar.envVarId);
      });

      yield* stack.destroy();
      yield* expectEnvVarGone(envVar.envVarId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a variable created elsewhere is refused unless adopted, and adopting rewrites its value",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      const foreign = yield* braintrust.createEnvVar({
        object_type: "project",
        object_id: project.projectId,
        name: "ALCHEMY_TEST_FOREIGN",
        value: Redacted.make("sk-test-foreign-00000"),
      });

      const app = (allow: boolean) =>
        inProject({ name: "ALCHEMY_TEST_FOREIGN", value: Redacted.make(first) }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);
      yield* expectStoredValue(foreign.id, "sk-test-foreign-00000");

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.envVarId).toBe(foreign.id);
      yield* expectStoredValue(foreign.id, first);

      yield* stack.destroy();
      yield* expectEnvVarGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
