/**
 * How Braintrust bindings reach Braintrust from any host.
 *
 * Braintrust signs no workload identity (no OIDC tokens, no federation), so
 * each host gets its own: a `Braintrust.ServiceAccount` and a
 * `Braintrust.ServiceToken` for it, created at deploy in the host's
 * namespace, and one `Braintrust.Acl` per permission a binding needs, on the
 * object it binds. Every binding on a host shares the account and token;
 * the grants add up. Destroying the host revokes the token and removes the
 * account and its grants. The deployer's credentials never reach a host.
 *
 * The token is bound into the host as `BRAINTRUST_API_KEY`, still
 * `Redacted`, with the deployer's API URL as `BRAINTRUST_API_URL`. Inside
 * the host every call provides `Credentials` from them, so nothing reads
 * `process.env`. Without a host (a script) nothing is created, and calls use
 * the ambient credentials.
 *
 * Creating the token needs a deployer signed in with a service token
 * (`bt-st-…`); Braintrust refuses to create service tokens with a user API
 * key. Braintrust also refuses a token that outlives the deployer's, so a
 * host's token expires with an expiring deployer token.
 */
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_URL,
} from "@distilled.cloud/braintrust/Credentials";
import { orDieCredentialsUnavailable } from "alchemy/Auth/Resolve";
import * as Binding from "alchemy/Binding";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { Acl } from "./Acl.ts";
import { ServiceAccount } from "./ServiceAccount.ts";
import { ServiceToken } from "./ServiceToken.ts";

/** A plain value as an Output with no requirements (`asOutput` leaves them `any`). */
const output = <A>(value: A) => Output.asOutput(value) as Output.Output<A, never>;

/** One permission a binding needs on the object it binds. */
export interface Grant {
  readonly objectType: braintrust.AclObjectType;
  readonly permission: braintrust.Permission;
  /** Limits the grant to objects of this type inside the bound object. */
  readonly restrictObjectType?: braintrust.AclObjectType;
}

export interface BraintrustAuth {
  /** Runs a distilled call with the host's token and an HTTP client. */
  readonly authorize: <A, E>(
    effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, RuntimeContext>;
}

const pascal = (value: string) =>
  value.replace(/(^|_)([a-z])/g, (_, __, letter: string) => letter.toUpperCase());

/**
 * Grants the host's service account `grants` on `objectId`, the id of
 * `target`, and returns an `authorize` that runs calls with the host's
 * token. Grants of the same permission on the same object, from any binding,
 * are one ACL.
 */
export const bindBraintrust = Effect.fn("Braintrust.bind")(function* (
  target: { readonly FQN: string },
  objectId: Output.Output<string>,
  grants: ReadonlyArray<Grant>,
) {
  let apiKey = output(Redacted.make(""));
  let apiUrl = DEFAULT_API_URL;
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const credentials = yield* Effect.serviceOption(Credentials);
    const host = yield* Binding.Host;
    if (host === undefined) {
      const ambient = Layer.mergeAll(
        Option.isSome(credentials)
          ? Layer.succeed(Credentials, credentials.value)
          : CredentialsFromEnv,
        FetchHttpClient.layer,
      );
      return {
        authorize: (effect) => effect.pipe(Effect.provide(ambient)),
      } satisfies BraintrustAuth;
    }
    // Yielding the resource classes erases their `Providers` requirement;
    // the stack satisfies it at plan time.
    const makeAccount = yield* ServiceAccount;
    const makeToken = yield* ServiceToken;
    const makeAcl = yield* Acl;
    const token = yield* Namespace.push(
      host.LogicalId,
      Effect.gen(function* () {
        const account = yield* makeAccount("BraintrustServiceAccount", {});
        // The target's FQN, not its logical id, so same-named targets in
        // different namespaces get separate ACLs. `/` would nest the ACL's
        // own FQN, and `__` is how state files encode `/`.
        const targetId = target.FQN.replaceAll("/", "-");
        for (const grant of grants) {
          const restrict = grant.restrictObjectType;
          yield* makeAcl(
            `${targetId}${pascal(grant.objectType)}${pascal(grant.permission)}${restrict ? pascal(restrict) : ""}`,
            {
              objectType: grant.objectType,
              objectId,
              userId: account.serviceAccountId,
              permission: grant.permission,
              ...(restrict ? { restrictObjectType: restrict } : {}),
            },
          );
        }
        return yield* makeToken("BraintrustServiceToken", {
          serviceAccountId: account.serviceAccountId,
        });
      }),
    );
    apiKey = token.key as Output.Output<Redacted.Redacted<string>, never>;
    if (Option.isSome(credentials)) {
      apiUrl = (yield* credentials.value.pipe(orDieCredentialsUnavailable("Braintrust"))).apiUrl;
    }
  }
  const key = yield* Output.named(apiKey, "BRAINTRUST_API_KEY").asEffect();
  const url = yield* Output.named(output(apiUrl), "BRAINTRUST_API_URL").asEffect();
  const services = Layer.mergeAll(
    Layer.succeed(
      Credentials,
      Effect.all([key, url]).pipe(
        Effect.map(([apiKey, apiUrl]) => ({
          apiKey,
          apiUrl: (apiUrl || DEFAULT_API_URL).replace(/\/+$/, ""),
        })),
      ),
    ),
    FetchHttpClient.layer,
  );
  return {
    authorize: (effect) => effect.pipe(Effect.provide(services)),
  } satisfies BraintrustAuth;
});

/**
 * The impl of a binding on one Braintrust object: grants `grants` on the
 * object `id(target)` names, and builds the client over the object's id.
 * Each `<Op>Http.ts` is a `Layer.succeed(Cap, makeHttpBinding({ … }))`.
 */
export const makeHttpBinding =
  <Target extends { readonly FQN: string }, Client>(options: {
    /** The bound object's id, e.g. `experiment.experimentId`. */
    readonly id: (target: Target) => Output.Output<string>;
    readonly grants: ReadonlyArray<Grant>;
    readonly client: (auth: BraintrustAuth, id: Effect.Effect<string>) => Client;
  }) =>
  (target: Target) =>
    Effect.gen(function* () {
      const objectId = options.id(target);
      const auth = yield* bindBraintrust(target, objectId, options.grants);
      const id: Effect.Effect<string> = yield* (
        objectId as Output.Output<string, never>
      ).asEffect();
      return options.client(auth, id);
    });
