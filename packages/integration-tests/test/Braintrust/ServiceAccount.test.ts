import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { testName } from "../names.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:service-account", "live"];

/**
 * Braintrust can't read a service account back, but a group lists it while
 * it exists and drops it once it is removed. This test-owned group, made
 * through the API, is how the test sees the account out of band.
 */
const withProbeGroup = <A, E, R>(use: (groupId: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    braintrust.createGroup({ name: testName("alchemy-test-bt-sa-probe") }),
    (group) => use(group.id),
    (group) =>
      braintrust.deleteGroup({ group_id: group.id }).pipe(
        Effect.catchTag("NotFoundOrForbidden", () => Effect.void),
        Effect.ignore,
      ),
  );

const watch = (groupId: string, serviceAccountId: string) =>
  braintrust
    .updateGroup({ group_id: groupId, add_member_users: [serviceAccountId] })
    .pipe(Effect.map((group) => group.member_users ?? []));

const expectRemoved = (groupId: string, serviceAccountId: string) =>
  Effect.gen(function* () {
    const listed = yield* braintrust.getGroup({ group_id: groupId }).pipe(
      Effect.map((group) => (group.member_users ?? []).includes(serviceAccountId)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(listed).toBe(false);
  });

test.provider(
  "create a service account and remove it",
  (stack) =>
    withProbeGroup((probe) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const account = yield* stack.deploy(Braintrust.ServiceAccount("Account", {}));
        expect(account.serviceAccountId).toMatch(/^[0-9a-f-]{36}$/);
        expect(account.email).toContain(account.name);
        expect(yield* watch(probe, account.serviceAccountId)).toContain(account.serviceAccountId);

        const plan = yield* stack.plan(Braintrust.ServiceAccount("Account", {}));
        expect(plan.resources.Account.action).toBe("noop");

        yield* stack.destroy();
        yield* expectRemoved(probe, account.serviceAccountId);
      }),
    ),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming a service account replaces it and removes the old one",
  (stack) =>
    withProbeGroup((probe) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const first = yield* stack.deploy(
          Braintrust.ServiceAccount("Account", { name: testName("alchemy-test-bt-sa-a") }),
        );
        expect(first.name).toBe(testName("alchemy-test-bt-sa-a"));
        expect(yield* watch(probe, first.serviceAccountId)).toContain(first.serviceAccountId);

        const renamed = yield* stack.deploy(
          Braintrust.ServiceAccount("Account", { name: testName("alchemy-test-bt-sa-b") }),
        );
        expect(renamed.serviceAccountId).not.toBe(first.serviceAccountId);
        expect(renamed.name).toBe(testName("alchemy-test-bt-sa-b"));
        expect(yield* watch(probe, renamed.serviceAccountId)).toContain(renamed.serviceAccountId);
        yield* expectRemoved(probe, first.serviceAccountId);

        yield* stack.destroy();
        yield* expectRemoved(probe, renamed.serviceAccountId);
      }),
    ),
  { tags, timeout: 120_000 },
);
