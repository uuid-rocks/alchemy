import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Providers } from "./Providers.ts";

export interface OrganizationMemberProps {
  /** Email address of the person to invite. Changing it replaces the member. */
  email: string;
  /**
   * Email the person an invitation. Only applies when they are first
   * invited.
   * @default false
   */
  sendInviteEmail?: boolean;
}

export interface OrganizationMemberAttributes {
  /** User id of the member, used in groups and ACLs. */
  userId: string;
  /** Email address of the member. */
  email: string;
  /** Given name, once the person has signed up. */
  givenName: string | undefined;
  /** Family name, once the person has signed up. */
  familyName: string | undefined;
}

export type OrganizationMember = Resource<
  "Braintrust.OrganizationMember",
  OrganizationMemberProps,
  OrganizationMemberAttributes,
  never,
  Providers,
  OrganizationMemberLookup
>;

/**
 * Props for {@link OrganizationMember.lookup}: find a member of the
 * credentials' organization by email.
 */
export interface OrganizationMemberLookup {
  /** Email address of the member. */
  email: string;
}

/**
 * A person in the Braintrust organization, invited by email. Give them
 * access with a `Braintrust.Group` or a `Braintrust.Acl`. See
 * [Access control](https://www.braintrust.dev/docs/guides/access-control).
 *
 * A member found by email without prior state, such as someone already in
 * the organization, is refused unless adopted (`adopt(true)` or `--adopt`),
 * so destroying the stack never removes people Alchemy didn't invite.
 *
 * :::caution
 * Changing `email` replaces the member: the new address is invited and the
 * old one is removed from the organization.
 * :::
 *
 * ### Inviting a member
 * **Example:** Invite someone and email them
 * ```typescript
 * const member = yield* Braintrust.OrganizationMember("Ada", {
 *   email: "ada@example.com",
 *   sendInviteEmail: true,
 * });
 * ```
 *
 * **Example:** Invite someone into a group
 * ```typescript
 * const member = yield* Braintrust.OrganizationMember("Ada", {
 *   email: "ada@example.com",
 * });
 * const annotators = yield* Braintrust.Group("Annotators", {
 *   memberUserIds: [member.userId],
 * });
 * ```
 *
 * ### Looking up a member
 * **Example:** Reference someone already in the organization
 * ```typescript
 * const ada = Braintrust.OrganizationMember.lookup({ email: "ada@example.com" });
 * ```
 *
 * @resource
 * @product Organization
 */
export const OrganizationMember = Resource<OrganizationMember>("Braintrust.OrganizationMember");

/** Braintrust accepted an invite but the member can't be found by email. */
export class OrganizationMemberNotInvited extends Data.TaggedError("OrganizationMemberNotInvited")<{
  email: string;
}> {
  override get message() {
    return `Braintrust did not add ${this.email} to the organization`;
  }
}

const toAttributes = (user: braintrust.User, email: string): OrganizationMemberAttributes => ({
  userId: user.id,
  email: user.email ?? email,
  givenName: user.given_name ?? undefined,
  familyName: user.family_name ?? undefined,
});

// Users are global accounts, so `getUser` and `listUsers` answer only for
// members of the credentials' organization: a removed member reads as missing.
const getById = (userId: string) =>
  braintrust
    .getUser({ user_id: userId })
    .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined));

const findByEmail = (email: string) =>
  braintrust.listUsers.items({ email }).pipe(
    Stream.filter((user) => user.email?.toLowerCase() === email.toLowerCase()),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const OrganizationMemberProvider = () =>
  Provider.effect(
    OrganizationMember,
    Effect.gen(function* () {
      return {
        stables: ["userId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.email.toLowerCase() !== olds.email.toLowerCase()) {
            return { action: "replace" } as const;
          }
        }),
        lookup: Effect.fn(function* ({ email }) {
          const user = yield* findByEmail(email);
          return user ? toAttributes(user, email) : undefined;
        }),
        read: Effect.fn(function* ({ olds, output, previous }) {
          if (output) {
            const user = yield* getById(output.userId);
            return user ? toAttributes(user, output.email) : undefined;
          }
          const user = yield* findByEmail(olds.email);
          if (!user) return undefined;
          // An email is user-chosen, so a member found without state may
          // have joined some other way.
          return unownedUnlessPrevious(toAttributes(user, olds.email), previous, "userId");
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          // Observe — by id once we have one, else by email.
          const cached = output ? yield* getById(output.userId) : undefined;
          let user =
            (cached?.email?.toLowerCase() === news.email.toLowerCase() ? cached : undefined) ??
            (yield* findByEmail(news.email));

          // Ensure — inviting someone already in the organization adds no one.
          if (!user) {
            yield* session.note(`Inviting ${news.email}...`);
            yield* braintrust.updateOrganizationMembers({
              invite_users: {
                emails: [news.email],
                send_invite_emails: news.sendInviteEmail ?? false,
              },
            });
            user = yield* findByEmail(news.email);
            if (!user) {
              return yield* new OrganizationMemberNotInvited({ email: news.email });
            }
          }

          return toAttributes(user, news.email);
        }),
        delete: Effect.fn(function* ({ output }) {
          // Removing someone who already left succeeds.
          yield* braintrust.updateOrganizationMembers({
            remove_users: { ids: [output.userId] },
          });
        }),
        // Members are people; `alchemy unsafe nuke` never removes them.
        list: () => Effect.succeed([]),
      };
    }),
  );
