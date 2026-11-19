import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { testName } from "../names.ts";
import { eventually } from "./lookup.ts";

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
 * no objects, so success of an authenticated list is the signal. Only a 401
 * counts as rejection; any other failure fails the test.
 */
const accepts = (key: Redacted.Redacted<string>) =>
  braintrust.listProjects.items({ limit: 1 }).pipe(
    Stream.runHead,
    Effect.provide(Braintrust.fromApiKey({ apiKey: key })),
    Effect.as(true),
    Effect.catchTag("Unauthorized", () => Effect.succeed(false)),
  );

// A just-minted key can be refused for a moment: in one run, a key checked
// right after the deploy that created it came back 401.
const expectAccepted = (key: Redacted.Redacted<string>) =>
  eventually(accepts(key), (ok) => expect(ok).toBe(true));

// The deployer's own token expires, and Braintrust refuses tokens that
// outlive it, so every test token sets an expiry.
const program = (expiresInSeconds: number, accountName?: string) =>
  Effect.gen(function* () {
    const account = yield* Braintrust.ServiceAccount("Account", { name: accountName });
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
      // Assertions on the key compare booleans, so a failure never prints it.
      expect(Redacted.value(token.key).startsWith("bt-st-")).toBe(true);
      expect(token.previewName.slice(-4) === Redacted.value(token.key).slice(-4)).toBe(true);
      expect(token.expiresAt).toBeTypeOf("string");
      const observed = yield* getServiceToken(token.serviceTokenId);
      expect(observed.name).toBe(token.name);
      expect(observed.service_account_id).toBe(token.serviceAccountId);
      yield* expectAccepted(token.key);
      // Braintrust ignores characters appended to a key, so change one instead.
      const value = Redacted.value(token.key);
      const tampered = `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
      expect(yield* accepts(Redacted.make(tampered))).toBe(false);

      const plan = yield* stack.plan(program(3600));
      expect(plan.resources.Token.action).toBe("noop");

      // A redeploy keeps the key Braintrust returned once.
      const redeployed = yield* stack.deploy(program(3600));
      expect(redeployed.serviceTokenId).toBe(token.serviceTokenId);
      expect(Redacted.value(redeployed.key) === Redacted.value(token.key)).toBe(true);

      const rotated = yield* stack.deploy(program(7200));
      expect(rotated.serviceTokenId).not.toBe(token.serviceTokenId);
      expect(rotated.serviceAccountId).toBe(token.serviceAccountId);
      expect(Redacted.value(rotated.key) === Redacted.value(token.key)).toBe(false);
      yield* expectTokenGone(token.serviceTokenId);
      // Braintrust caches accepted keys for a while after revocation.
      const stillAccepted = yield* accepts(token.key).pipe(
        Effect.repeat({ schedule: Schedule.spaced("6 seconds"), until: (ok) => !ok, times: 10 }),
      );
      expect(stillAccepted).toBe(false);

      // Renaming the account replaces it, and its new id is known only at
      // apply, so the plan already replaces the token instead of updating it.
      const renamed = program(7200, testName("alchemy-test-bt-st-account"));
      expect((yield* stack.plan(renamed)).resources.Token.action).toBe("replace");
      const moved = yield* stack.deploy(renamed);
      expect(moved.serviceAccountId).not.toBe(rotated.serviceAccountId);
      expect(moved.serviceTokenId).not.toBe(rotated.serviceTokenId);
      yield* expectAccepted(moved.key);
      yield* expectTokenGone(rotated.serviceTokenId);

      yield* stack.destroy();
      yield* expectTokenGone(moved.serviceTokenId);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a deploy replaces an expired token",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const token = yield* stack.deploy(program(30));
      expect(token.expiresAt).toBeTypeOf("string");
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(Math.max(0, Date.parse(token.expiresAt!) - now) + 1_000);

      const plan = yield* stack.plan(program(30));
      expect(plan.resources.Token.action).toBe("replace");
      const renewed = yield* stack.deploy(program(30));
      expect(renewed.serviceTokenId).not.toBe(token.serviceTokenId);
      yield* expectAccepted(renewed.key);
      yield* expectTokenGone(token.serviceTokenId);

      yield* stack.destroy();
      yield* expectTokenGone(renewed.serviceTokenId);
    }),
  { tags, timeout: 120_000 },
);
