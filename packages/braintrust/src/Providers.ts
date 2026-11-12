import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { BraintrustAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";

/**
 * Service tag bundling all Braintrust providers + auth + credentials. Use
 * `Braintrust.providers()` to materialize the full layer.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("Braintrust") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build the complete Braintrust providers Layer: every Braintrust resource,
 * the Braintrust AuthProvider registration (so `alchemy profile edit` can
 * configure it), and credential resolution.
 *
 * @example
 * ```ts
 * Alchemy.Stack("App", { providers: Braintrust.providers() }, ...)
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([])).pipe(
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(BraintrustAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
