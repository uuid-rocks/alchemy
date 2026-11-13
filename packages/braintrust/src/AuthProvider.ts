import { DEFAULT_API_URL } from "@distilled.cloud/braintrust/Credentials";
import { AuthError } from "alchemy/Auth/AuthProvider";
import { getEnv, getEnvRedacted } from "alchemy/Auth/Env";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "alchemy/Auth/StoredAuthProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * Canonical name registered in the AuthProviders registry. Use this key to
 * look up the Braintrust AuthProvider from inside provider Layers.
 */
export const BRAINTRUST_AUTH_PROVIDER_NAME = "Braintrust";

export type BraintrustAuthConfig = StoredAuthConfig;

/**
 * Resolved Braintrust API credentials: an API key (a user key `sk-…` or a
 * service token `bt-st-…`) and the API URL. The organization is the key's.
 */
export interface BraintrustResolvedCredentials {
  type: "apiKey";
  apiKey: Redacted.Redacted<string>;
  apiUrl: string;
  source: { type: BraintrustAuthConfig["method"] | "env"; details?: string };
}

const readEnvironment = Effect.gen(function* () {
  const apiKey = yield* getEnvRedacted("BRAINTRUST_API_KEY");
  if (apiKey === undefined || Redacted.value(apiKey).trim().length === 0) {
    return yield* AuthError.make({
      message: "Braintrust CI credentials not found. Set BRAINTRUST_API_KEY.",
    });
  }
  return {
    type: "apiKey" as const,
    apiKey: Redacted.make(Redacted.value(apiKey).trim()),
    apiUrl: (yield* getEnv("BRAINTRUST_API_URL")) ?? DEFAULT_API_URL,
    source: { type: "env" as const, details: "BRAINTRUST_API_KEY" },
  } satisfies BraintrustResolvedCredentials;
});

const braintrustAuth = makeStoredAuthProvider<BraintrustResolvedCredentials>({
  provider: BRAINTRUST_AUTH_PROVIDER_NAME,
  fields: [
    {
      name: "apiKey",
      label: "Braintrust API Key",
      description:
        "Create one under Settings → API keys, or a service token for a service account.",
      secret: true,
      validate: (value) => (value.trim().length === 0 ? "Required" : undefined),
    },
    {
      name: "apiUrl",
      label: "Braintrust API URL",
      description: "Only for a self-hosted data plane.",
      optional: true,
      placeholder: DEFAULT_API_URL,
    },
  ],
  toResolved: (values, source) => ({
    type: "apiKey",
    apiKey: storedSecret(values.apiKey) ?? Redacted.make(""),
    apiUrl: storedValueText(values.apiUrl) ?? DEFAULT_API_URL,
    source: { type: source },
  }),
  readEnvironment,
  environment: [
    {
      name: "BRAINTRUST_API_KEY",
      required: true,
      secret: true,
      description: "Braintrust API key or service token.",
    },
    {
      name: "BRAINTRUST_API_URL",
      required: false,
      description: "API URL override for a self-hosted data plane.",
    },
  ],
});

/**
 * Layer that registers the Braintrust AuthProvider into the AuthProviders
 * registry when built. Included in `Braintrust.providers()` so the alchemy
 * CLI (`alchemy profile edit`) can configure it.
 */
export const BraintrustAuth = braintrustAuth.layer;

/** Schema of Braintrust's stored API-key values. */
export const BraintrustStoredCredentials = braintrustAuth.storedSchema;
export type BraintrustStoredCredentials = typeof BraintrustStoredCredentials.Type;
