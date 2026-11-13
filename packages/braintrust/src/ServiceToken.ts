import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { braintrustName, isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface ServiceTokenProps {
  /** Id of the service account the token acts as, e.g. `serviceAccount.serviceAccountId`. */
  serviceAccountId: string;
  /**
   * Token name. Names don't have to be unique. If omitted, a name is
   * generated from the stack, stage and logical ID.
   */
  name?: string;
  /**
   * Seconds from creation until the token expires. Omit for a token that
   * never expires. When you deploy with a token that expires, Braintrust
   * refuses new tokens that would outlive it, so set this.
   */
  expiresInSeconds?: number;
}

export interface ServiceTokenAttributes {
  /** Unique identifier of the service token. */
  serviceTokenId: string;
  /** Id of the service account the token acts as. */
  serviceAccountId: string;
  /** Token name. */
  name: string;
  /** Masked preview of the token, e.g. `bt-st-…AbCd`. */
  previewName: string;
  /** The token itself (`bt-st-…`). Braintrust returns it only when the token is created. */
  key: Redacted.Redacted<string>;
  /** When the token expires (ISO 8601); `undefined` if it never does. */
  expiresAt: string | undefined;
  /** When the token was created (ISO 8601). */
  created: string | undefined;
}

export type ServiceToken = Resource<
  "Braintrust.ServiceToken",
  ServiceTokenProps,
  ServiceTokenAttributes,
  never,
  Providers
>;

/**
 * A Braintrust service token: an API key (`bt-st-…`) that acts as a service
 * account, with that account's access. See
 * [Service tokens](https://www.braintrust.dev/docs/guides/access-control#service-tokens).
 *
 * Braintrust returns the key once, when the token is created. Alchemy keeps
 * it `Redacted` in state, so it can be passed to other resources as a
 * secret. A token can't be changed, so changing any prop replaces it with a
 * new key, and destroying it revokes the key. There is no lookup: a token
 * found later has no key to give.
 *
 * Creating a service token needs a service token deployer (a user API key is
 * refused) with all of the service account's permissions.
 *
 * :::caution
 * Every prop replaces the token: a new key is created and the old one is
 * revoked once everything using the token has been updated.
 * :::
 *
 * ### Creating a Service Token
 * **Example:** A 90-day token for a service account
 * ```typescript
 * const ci = yield* Braintrust.ServiceAccount("CI", {});
 * const token = yield* Braintrust.ServiceToken("CIToken", {
 *   serviceAccountId: ci.serviceAccountId,
 *   expiresInSeconds: 90 * 24 * 60 * 60,
 * });
 * ```
 *
 * ### Rotating a Service Token
 * **Example:** Rename the token to rotate its key
 * ```typescript
 * const ci = yield* Braintrust.ServiceAccount("CI", {});
 * const token = yield* Braintrust.ServiceToken("CIToken", {
 *   serviceAccountId: ci.serviceAccountId,
 *   name: "ci-2026-12",
 *   expiresInSeconds: 90 * 24 * 60 * 60,
 * });
 * ```
 *
 * @resource
 * @product Access control
 */
export const ServiceToken = Resource<ServiceToken>("Braintrust.ServiceToken");

const toAttributes = (
  token: braintrust.ServiceToken,
  key: Redacted.Redacted<string>,
): ServiceTokenAttributes => ({
  serviceTokenId: token.id,
  serviceAccountId: token.service_account_id ?? "",
  name: token.name,
  previewName: token.preview_name,
  key,
  expiresAt: token.expires_at ?? undefined,
  created: token.created ?? undefined,
});

const getById = (serviceTokenId: string) =>
  braintrust
    .getServiceToken({ service_token_id: serviceTokenId })
    .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined));

export const ServiceTokenProvider = () =>
  Provider.effect(
    ServiceToken,
    Effect.gen(function* () {
      return {
        stables: ["serviceTokenId", "serviceAccountId", "key"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          // A token has no update; any change is a new token.
          if (!deepEqual(news, olds)) return { action: "replace" } as const;
        }),
        read: Effect.fn(function* ({ output }) {
          // Without state there is no key to recover, so nothing is ours.
          if (!output) return undefined;
          const token = yield* getById(output.serviceTokenId);
          return token ? toAttributes(token, output.key) : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          // Observe — by the cached id; the key exists only in state.
          const cached = output ? yield* getById(output.serviceTokenId) : undefined;
          if (output && cached?.service_account_id === news.serviceAccountId) {
            return toAttributes(cached, output.key);
          }

          // Ensure — a missing token (revoked outside Alchemy) gets a new key.
          const name = yield* braintrustName(id, news.name);
          yield* session.note(`Creating service token ${name}...`);
          const created = yield* braintrust.createServiceToken({
            name,
            service_account_id: news.serviceAccountId,
            expires_in_seconds: news.expiresInSeconds,
          });
          const key = Redacted.isRedacted(created.key) ? created.key : Redacted.make(created.key);
          return toAttributes(created, key);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteServiceToken({ service_token_id: output.serviceTokenId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          // Only generated names: the token the deployer signs in with is
          // never in the list.
          const tokens = yield* Stream.runCollect(braintrust.listServiceTokens.items({}));
          return tokens
            .filter((token) => isGeneratedName(token.name))
            .map((token) => toAttributes(token, Redacted.make("")));
        }),
      };
    }),
  );
