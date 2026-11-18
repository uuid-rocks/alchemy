/**
 * How Braintrust bindings reach Braintrust from any host.
 *
 * Braintrust signs no workload identity (no OIDC tokens, no federation), so
 * each host gets its own: a `Braintrust.ServiceAccount` and a
 * `Braintrust.ServiceToken` for it, created at deploy in the host's
 * namespace. Each binding adds the permissions it needs, on the object it
 * binds, to the host's grants, which keep the account's ACLs at exactly one
 * per distinct grant once the bound objects' ids are known. The bindings own
 * the account: an ACL on it that no binding asks for is revoked. Every
 * binding on a host shares the account and token. Destroying the host
 * revokes the token and removes the account and its grants. The deployer's
 * credentials never reach a host.
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
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HostGrants } from "./internal/HostGrants.ts";
import { ServiceAccount } from "./ServiceAccount.ts";
import { ServiceToken } from "./ServiceToken.ts";

/** A plain value as an Output with no requirements (`asOutput` leaves them `any`). */
const output = <A>(value: A) => Output.asOutput(value) as Output.Output<A, never>;

/** Binding positions taken so far on each host's grants, per stack build. */
const grantCounters = new WeakMap<object, Map<string, number>>();
const noStack = {};

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

/**
 * Grants the host's service account `grants` on `objectId`, and returns an
 * `authorize` that runs calls with the host's token. Grants of the same
 * permission on the same object, from any binding, are one ACL.
 */
export const bindBraintrust = Effect.fn("Braintrust.bind")(function* (
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
    const makeGrants = yield* HostGrants;
    const stack = yield* Effect.serviceOption(Stack);
    const stackKey = Option.isSome(stack) ? stack.value : noStack;
    const token = yield* Namespace.push(
      host.LogicalId,
      Effect.gen(function* () {
        const account = yield* makeAccount("BraintrustServiceAccount", {});
        const hostGrants = yield* makeGrants("BraintrustGrants", {
          serviceAccountId: account.serviceAccountId,
        });
        // Nothing known at plan time tells two bound objects apart (a
        // lookup's props can be closures over different values), so each
        // binding gets its own sid by position and the grants are deduped
        // once their ids resolve. The position is read and taken in one
        // step: concurrent bindings that read the same position get the
        // same sid, and core keeps only one row per sid.
        const index = yield* Effect.sync(() => {
          const counters = grantCounters.get(stackKey) ?? new Map<string, number>();
          grantCounters.set(stackKey, counters);
          const next = counters.get(hostGrants.FQN) ?? 0;
          counters.set(hostGrants.FQN, next + 1);
          return next;
        });
        yield* hostGrants.bind(`Grant${index}`, {
          grants: grants.map((grant) => ({ ...grant, objectId })),
        });
        // Through the grants, so the host gets its token once they exist.
        return yield* makeToken("BraintrustServiceToken", {
          serviceAccountId: hostGrants.serviceAccountId,
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
  <Target, Client>(options: {
    /** The bound object's id, e.g. `experiment.experimentId`. */
    readonly id: (target: Target) => Output.Output<string>;
    readonly grants: ReadonlyArray<Grant>;
    readonly client: (auth: BraintrustAuth, id: Effect.Effect<string>) => Client;
  }) =>
  (target: Target) =>
    Effect.gen(function* () {
      const objectId = options.id(target);
      const auth = yield* bindBraintrust(objectId, options.grants);
      const id: Effect.Effect<string> = yield* (
        objectId as Output.Output<string, never>
      ).asEffect();
      return options.client(auth, id);
    });
