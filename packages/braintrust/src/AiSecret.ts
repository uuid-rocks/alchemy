import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { deepEqual } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { braintrustName, isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface AiSecretProps {
  /**
   * Secret name, unique within the organization. If omitted, a unique name
   * is generated from the stack, stage and logical ID. Renaming updates the
   * secret in place.
   */
  name?: string;
  /**
   * The AI provider the secret is for, e.g. `openai`, `anthropic` or
   * `bedrock`. Removing it clears the type.
   */
  type?: string;
  /**
   * Provider settings, such as a custom endpoint or the models it serves.
   * Replaced as a whole on every change; removing it clears the metadata.
   */
  metadata?: Record<string, unknown>;
  /**
   * The provider's API key. Braintrust encrypts it at rest and never
   * returns it. Changing it updates the secret in place.
   */
  secret: Redacted.Redacted<string>;
}

export interface AiSecretAttributes {
  /** Unique identifier of the secret. */
  aiSecretId: string;
  /** Id of the organization the secret belongs to. */
  orgId: string;
  /** Secret name. */
  name: string;
  /** The AI provider the secret is for. */
  type: string | undefined;
  /** Provider settings. */
  metadata: Record<string, unknown> | undefined;
  /** Braintrust's masked preview of the stored secret. */
  previewSecret: Redacted.Redacted<string> | undefined;
  /** When the secret value was last written (ISO 8601). */
  secretUpdatedAt: string | undefined;
  /** When the secret was created (ISO 8601). */
  created: string | undefined;
}

export type AiSecret = Resource<
  "Braintrust.AiSecret",
  AiSecretProps,
  AiSecretAttributes,
  never,
  Providers,
  AiSecretLookup
>;

/**
 * Props for {@link AiSecret.lookup}: find an AI secret this stack doesn't
 * manage by its name. The secret value is never returned.
 */
export interface AiSecretLookup {
  /** Secret name. */
  name: string;
}

/**
 * A Braintrust AI provider secret: an organization-wide API key for an LLM
 * provider that the playground, the AI proxy, prompts and online scorers use
 * to call models. See
 * [AI providers](https://www.braintrust.dev/docs/integrations/ai-providers).
 *
 * The key is a `Redacted` string: Alchemy never logs it, and state keeps it
 * as a `Redacted` value like every other secret prop. Braintrust never
 * returns it, so Alchemy tracks when the key was last written: a key rotated
 * in the Braintrust UI shows up in `alchemy drift`, and repairing the drift
 * writes the key from the props again.
 * Since the stored key can't be compared, every update writes it again.
 *
 * Secrets carry no tags Alchemy can use for ownership, so a secret found
 * under an explicit `name` with no prior state is refused unless adopted.
 * Adopting one rewrites its key.
 *
 * ### Creating an AI secret
 * **Example:** OpenAI key
 * ```typescript
 * import * as Config from "effect/Config";
 *
 * const openai = yield* Braintrust.AiSecret("OpenAI", {
 *   name: "OPENAI_API_KEY",
 *   type: "openai",
 *   secret: yield* Config.redacted("OPENAI_API_KEY"),
 * });
 * ```
 *
 * **Example:** OpenAI-compatible endpoint with provider settings
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * const gateway = yield* Braintrust.AiSecret("Gateway", {
 *   type: "openai",
 *   metadata: { api_base: "https://llm.example.com/v1", models: ["gpt-4o"] },
 *   secret: Redacted.make(process.env.GATEWAY_KEY!),
 * });
 * ```
 *
 * ### Looking up an existing secret
 * **Example:** Reference a secret made in the Braintrust UI
 * ```typescript
 * const openai = Braintrust.AiSecret.lookup({ name: "OPENAI_API_KEY" });
 * ```
 *
 * @resource
 * @product AiSecret
 */
export const AiSecret = Resource<AiSecret>("Braintrust.AiSecret");

const toAttributes = (secret: braintrust.AISecret): AiSecretAttributes => ({
  aiSecretId: secret.id,
  orgId: secret.org_id,
  name: secret.name,
  type: secret.type ?? undefined,
  metadata: secret.metadata ?? undefined,
  previewSecret:
    secret.preview_secret == null
      ? undefined
      : Redacted.isRedacted(secret.preview_secret)
        ? secret.preview_secret
        : Redacted.make(secret.preview_secret),
  secretUpdatedAt: secret.secret_updated_at ?? undefined,
  created: secret.created ?? undefined,
});

const getById = (aiSecretId: string) =>
  braintrust
    .getAiSecret({ ai_secret_id: aiSecretId })
    .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined));

const findByName = (name: string) =>
  braintrust.listAiSecrets.items({ ai_secret_name: name }).pipe(
    Stream.filter((secret) => secret.name === name),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const AiSecretProvider = () =>
  Provider.effect(
    AiSecret,
    Effect.gen(function* () {
      return {
        stables: ["aiSecretId", "orgId"],
        lookup: Effect.fn(function* ({ name }) {
          const secret = yield* findByName(name);
          return secret ? toAttributes(secret) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const secret = yield* getById(output.aiSecretId);
            return secret ? toAttributes(secret) : undefined;
          }
          const secret = yield* findByName(yield* braintrustName(id, olds?.name));
          if (!secret) return undefined;
          const attrs = toAttributes(secret);
          // A generated name carries this instance's suffix, so it is ours.
          return olds?.name === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "aiSecretId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* braintrustName(id, news.name);

          // Observe — by id once we have one (it survives renames), else by name.
          let secret =
            (output ? yield* getById(output.aiSecretId) : undefined) ?? (yield* findByName(name));

          // Ensure — POST returns an existing secret of the same name
          // unchanged (its key too), so a concurrent create converges on one
          // secret.
          let created = false;
          if (!secret) {
            yield* session.note(`Creating AI secret ${name}...`);
            secret = yield* braintrust.createAiSecret({
              name,
              type: news.type,
              metadata: news.metadata,
              secret: news.secret,
            });
            created = true;
          }

          // Sync the name and key with PATCH. The key can't be observed, so
          // it is written whenever reconcile runs: on a props change, an
          // adoption, or a drift repair after it was rotated elsewhere (which
          // `read` reports through the changed update time). A create has
          // just written it.
          const update: Omit<braintrust.UpdateAiSecretRequest, "ai_secret_id"> = {};
          if (secret.name !== name) update.name = name;
          if (!created) update.secret = news.secret;
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating AI secret ${name}...`);
            secret = yield* braintrust.updateAiSecret({ ai_secret_id: secret.id, ...update });
          }

          // Sync type and metadata with PUT: PATCH ignores `null` and
          // deep-merges metadata, so it can neither clear them nor drop a
          // key. PUT replaces both by name and keeps the stored key when it
          // is omitted.
          if (
            (secret.type ?? undefined) !== news.type ||
            !deepEqual(secret.metadata ?? undefined, news.metadata)
          ) {
            yield* session.note(`Updating AI secret ${name}...`);
            secret = yield* braintrust.replaceAiSecret({
              name,
              type: news.type ?? null,
              metadata: news.metadata ?? null,
            });
          }

          return toAttributes(secret);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteAiSecret({ ai_secret_id: output.aiSecretId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const secrets = yield* Stream.runCollect(braintrust.listAiSecrets.items({}));
          return secrets.filter((secret) => isGeneratedName(secret.name)).map(toAttributes);
        }),
      };
    }),
  );
