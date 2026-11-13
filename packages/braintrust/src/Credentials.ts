import { Credentials } from "@distilled.cloud/braintrust/Credentials";
import { ConfigError } from "@distilled.cloud/core/errors";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Layer from "effect/Layer";
import {
  BRAINTRUST_AUTH_PROVIDER_NAME,
  type BraintrustResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  DEFAULT_API_URL,
  fromApiKey,
} from "@distilled.cloud/braintrust/Credentials";

/**
 * Build a `Credentials` layer that resolves Braintrust credentials through
 * the Alchemy AuthProvider: `BRAINTRUST_API_KEY` (and `BRAINTRUST_API_URL`)
 * when set, otherwise the selected profile. Resolution is deferred until the
 * first API call, so building the provider layers never needs a profile.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    lazyCredentials<BraintrustResolvedCredentials, ConfigError>()(
      BRAINTRUST_AUTH_PROVIDER_NAME,
      (creds) => ({
        apiKey: creds.apiKey,
        apiUrl: creds.apiUrl.replace(/\/+$/, ""),
      }),
    ),
  );
