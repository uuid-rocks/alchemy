import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { testName } from "../names.ts";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:organization-member", "live"];

// example.com is reserved (RFC 2606): an invite there never reaches anyone,
// and no invite email is requested anyway.
const email = (base: string) => `${testName(base)}@example.com`;

const membersWithEmail = (address: string) =>
  Stream.runCollect(braintrust.listUsers.items({ email: address })).pipe(
    Effect.map((users) => users.map((user) => user.id)),
  );

const expectNotMember = (address: string) =>
  Effect.gen(function* () {
    const ids = yield* membersWithEmail(address).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (found) => found.length === 0,
        times: 10,
      }),
    );
    expect(ids).toEqual([]);
  });

test.provider(
  "invite a member without email, change the address, and remove them",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = email("alchemy-test-bt-member-a");
      const second = email("alchemy-test-bt-member-b");

      const member = yield* stack.deploy(Braintrust.OrganizationMember("Member", { email: first }));
      expect(member.email).toBe(first);
      expect(yield* membersWithEmail(first)).toEqual([member.userId]);
      expect((yield* braintrust.getUser({ user_id: member.userId })).email).toBe(first);
      yield* expectFound(Braintrust.OrganizationMember.lookup({ email: first }), member);

      const plan = yield* stack.plan(Braintrust.OrganizationMember("Member", { email: first }));
      expect(plan.resources.Member.action).toBe("noop");

      const moved = yield* stack.deploy(Braintrust.OrganizationMember("Member", { email: second }));
      expect(moved.userId).not.toBe(member.userId);
      expect(yield* membersWithEmail(second)).toEqual([moved.userId]);
      yield* expectNotMember(first);

      yield* stack.destroy();
      yield* expectNotMember(second);
    }),
  { tags, exclusive: "braintrust:org-members", timeout: 120_000 },
);

test.provider(
  "a member invited elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const address = email("alchemy-test-bt-foreign-member");
      yield* braintrust.updateOrganizationMembers({
        invite_users: { emails: [address], send_invite_emails: false },
      });
      const [foreignId] = yield* membersWithEmail(address);
      expect(foreignId).toMatch(/^[0-9a-f-]{36}$/);

      const app = (allow: boolean) =>
        Braintrust.OrganizationMember("Member", { email: address }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.userId).toBe(foreignId);

      yield* stack.destroy();
      yield* expectNotMember(address);
    }),
  { tags, exclusive: "braintrust:org-members", timeout: 120_000 },
);
