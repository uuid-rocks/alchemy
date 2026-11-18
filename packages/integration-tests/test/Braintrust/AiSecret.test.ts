import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Drift from "alchemy/Drift";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { testName } from "../names.ts";
import { eventually, expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:ai-secret", "live"];

// Dummy keys only: no test calls a model.
const first = "sk-test-alchemy-first-11111";
const second = "sk-test-alchemy-second-22222";

const getAiSecret = (aiSecretId: string) => braintrust.getAiSecret({ ai_secret_id: aiSecretId });

/** JSON with every `Redacted` value unwrapped, to check a key never comes back. */
const revealed = (value: unknown) =>
  JSON.stringify(value, (_, v) => (Redacted.isRedacted(v) ? Redacted.value(v) : v));

const expectAiSecretGone = (aiSecretId: string) =>
  Effect.gen(function* () {
    const exists = yield* getAiSecret(aiSecretId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

test.provider(
  "create an AI secret, rotate its key, replace and clear its settings in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const props = {
        type: "openai",
        metadata: { api_base: "https://a.example.com", region: "us" },
      };
      const secret = yield* stack.deploy(
        Braintrust.AiSecret("AiSecret", { ...props, secret: Redacted.make(first) }),
      );
      expect(secret.type).toBe("openai");
      expect(secret.metadata).toEqual(props.metadata);
      yield* eventually(getAiSecret(secret.aiSecretId), (created) => {
        expect(created.name).toBe(secret.name);
        expect(created.type).toBe("openai");
        expect(created.metadata).toEqual(props.metadata);
        expect(revealed(created)).not.toContain(first);
      });
      expect(Redacted.isRedacted(secret.previewSecret)).toBe(true);
      expect(revealed(secret)).not.toContain(first);
      // The provider's read reports the type and settings, never the key.
      const provider = yield* Provider.findProvider(Braintrust.AiSecret);
      const read = yield* provider.read!({
        id: "AiSecret",
        fqn: "AiSecret",
        instanceId: "00000000000000000000000000000000",
        olds: { ...props, secret: Redacted.make(first) },
        output: secret,
      });
      expect(read?.aiSecretId).toBe(secret.aiSecretId);
      expect(read?.type).toBe("openai");
      expect(read?.metadata).toEqual(props.metadata);
      expect(revealed(read)).not.toContain(first);
      yield* expectFound(Braintrust.AiSecret.lookup({ name: secret.name }), secret);

      const plan = yield* stack.plan(
        Braintrust.AiSecret("AiSecret", { ...props, secret: Redacted.make(first) }),
      );
      expect(plan.resources.AiSecret.action).toBe("noop");

      // Rotating the key leaves the type and settings alone.
      const rotated = yield* stack.deploy(
        Braintrust.AiSecret("AiSecret", { ...props, secret: Redacted.make(second) }),
      );
      expect(rotated.aiSecretId).toBe(secret.aiSecretId);
      expect(rotated.secretUpdatedAt).not.toBe(secret.secretUpdatedAt);
      expect(revealed(rotated)).not.toContain(second);
      yield* eventually(getAiSecret(secret.aiSecretId), (afterRotate) => {
        expect(afterRotate.type).toBe("openai");
        expect(afterRotate.metadata).toEqual(props.metadata);
        expect(revealed(afterRotate)).not.toContain(second);
      });

      // Settings are replaced, not merged: `region` goes.
      const changed = yield* stack.deploy(
        Braintrust.AiSecret("AiSecret", {
          type: "anthropic",
          metadata: { api_base: "https://b.example.com" },
          secret: Redacted.make(second),
        }),
      );
      expect(changed.aiSecretId).toBe(secret.aiSecretId);
      expect(changed.type).toBe("anthropic");
      expect(changed.metadata).toEqual({ api_base: "https://b.example.com" });
      yield* eventually(getAiSecret(secret.aiSecretId), (afterChange) => {
        expect(afterChange.type).toBe("anthropic");
        expect(afterChange.metadata).toEqual({ api_base: "https://b.example.com" });
      });

      const cleared = yield* stack.deploy(
        Braintrust.AiSecret("AiSecret", { secret: Redacted.make(second) }),
      );
      expect(cleared.aiSecretId).toBe(secret.aiSecretId);
      yield* eventually(getAiSecret(secret.aiSecretId), (after) => {
        expect(after.type ?? undefined).toBeUndefined();
        expect(after.metadata ?? undefined).toBeUndefined();
      });

      yield* stack.destroy();
      yield* expectAiSecretGone(secret.aiSecretId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a key rotated outside Alchemy is detected as drift and repaired",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const target = { name: stack.name, stage: stack.stage };

      const secret = yield* stack.deploy(
        Braintrust.AiSecret("AiSecret", { type: "openai", secret: Redacted.make(first) }),
      );
      const clean = yield* Drift.detect(target).pipe(Effect.provide(stack.state));
      expect(clean.resources.AiSecret?.action).toBe("unchanged");

      const outside = yield* braintrust.updateAiSecret({
        ai_secret_id: secret.aiSecretId,
        secret: Redacted.make("sk-test-outside-99999"),
      });

      const repaired = yield* Drift.repair(target).pipe(Effect.provide(stack.state));
      expect(repaired.resources.AiSecret?.action).toBe("repaired");
      // The key is write-only; a newer write time shows Alchemy wrote it again.
      yield* eventually(getAiSecret(secret.aiSecretId), (after) => {
        expect(Date.parse(after.secret_updated_at ?? "")).toBeGreaterThan(
          Date.parse(outside.secret_updated_at ?? ""),
        );
      });

      yield* stack.destroy();
      yield* expectAiSecretGone(secret.aiSecretId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an explicitly named AI secret keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = (name: string) =>
        Braintrust.AiSecret("AiSecret", { name, secret: Redacted.make(first) });
      const secret = yield* stack.deploy(app(testName("alchemy-test-bt-ai-a")));
      const renamed = yield* stack.deploy(app(testName("alchemy-test-bt-ai-b")));
      expect(renamed.aiSecretId).toBe(secret.aiSecretId);
      yield* eventually(getAiSecret(secret.aiSecretId), (observed) => {
        expect(observed.name).toBe(testName("alchemy-test-bt-ai-b"));
      });

      yield* stack.destroy();
      yield* expectAiSecretGone(secret.aiSecretId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "an AI secret created elsewhere is refused unless adopted, and adopting rewrites its key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-ai");

      const foreign = yield* braintrust.createAiSecret({
        name,
        type: "openai",
        secret: Redacted.make("sk-test-foreign-00000"),
      });

      const app = (allow: boolean) =>
        Braintrust.AiSecret("Foreign", {
          name,
          type: "openai",
          secret: Redacted.make(first),
        }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.aiSecretId).toBe(foreign.id);
      expect(Date.parse(adopted.secretUpdatedAt ?? "")).toBeGreaterThan(
        Date.parse(foreign.secret_updated_at ?? ""),
      );

      yield* stack.destroy();
      yield* expectAiSecretGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
