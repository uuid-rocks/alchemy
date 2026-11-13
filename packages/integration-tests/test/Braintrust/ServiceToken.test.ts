import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:service-token", "live"];

const getServiceToken = (serviceTokenId: string) =>
  braintrust.getServiceToken({ service_token_id: serviceTokenId });

const expectTokenGone = (serviceTokenId: string) =>
  Effect.gen(function* () {
    const exists = yield* getServiceToken(serviceTokenId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

/**
 * Whether Braintrust accepts the key. A service account with no grants sees
 * no objects, so success of an authenticated list is the signal.
 */
const accepts = (key: Redacted.Redacted<string>) =>
  braintrust.listProjects
    .items({ limit: 1 })
    .pipe(
      Stream.runHead,
      Effect.provide(Braintrust.fromApiKey({ apiKey: key })),
      Effect.result,
      Effect.map(Result.isSuccess),
    );

// The deployer's own token expires, and Braintrust refuses tokens that
// outlive it, so every test token sets an expiry.
const program = (expiresInSeconds: number) =>
  Effect.gen(function* () {
    const account = yield* Braintrust.ServiceAccount("Account", {});
    return yield* Braintrust.ServiceToken("Token", {
      serviceAccountId: account.serviceAccountId,
      expiresInSeconds,
    });
  });

test.provider(
  "create a service token, rotate it by replacing it, and revoke it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const token = yield* stack.deploy(program(3600));
      expect(Redacted.isRedacted(token.key)).toBe(true);
      expect(Redacted.value(token.key)).toMatch(/^bt-st-/);
      expect(token.previewName.slice(-4)).toBe(Redacted.value(token.key).slice(-4));
      expect(token.expiresAt).toBeTypeOf("string");
      const observed = yield* getServiceToken(token.serviceTokenId);
      expect(observed.name).toBe(token.name);
      expect(observed.service_account_id).toBe(token.serviceAccountId);
      expect(yield* accepts(token.key)).toBe(true);
      // Braintrust ignores characters appended to a key, so change one instead.
      const value = Redacted.value(token.key);
      const tampered = `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
      expect(yield* accepts(Redacted.make(tampered))).toBe(false);

      const plan = yield* stack.plan(program(3600));
      expect(plan.resources.Token.action).toBe("noop");

      // A redeploy keeps the key Braintrust returned once.
      const redeployed = yield* stack.deploy(program(3600));
      expect(redeployed.serviceTokenId).toBe(token.serviceTokenId);
      expect(Redacted.value(redeployed.key)).toBe(Redacted.value(token.key));

      const rotated = yield* stack.deploy(program(7200));
      expect(rotated.serviceTokenId).not.toBe(token.serviceTokenId);
      expect(rotated.serviceAccountId).toBe(token.serviceAccountId);
      expect(Redacted.value(rotated.key)).not.toBe(Redacted.value(token.key));
      yield* expectTokenGone(token.serviceTokenId);
      // Braintrust caches accepted keys for a while after revocation.
      const stillAccepted = yield* accepts(token.key).pipe(
        Effect.repeat({ schedule: Schedule.spaced("5 seconds"), until: (ok) => !ok, times: 18 }),
      );
      expect(stillAccepted).toBe(false);

      yield* stack.destroy();
      yield* expectTokenGone(rotated.serviceTokenId);
    }),
  { tags, timeout: 120_000 },
);
