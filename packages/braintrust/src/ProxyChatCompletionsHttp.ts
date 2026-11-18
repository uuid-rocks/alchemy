import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { ProxyChatCompletions, type ProxyChatCompletionsClient } from "./ProxyChatCompletions.ts";
import { AI_SECRET_READ, aiSecretId } from "./ProxyHttp.ts";

/**
 * HTTP implementation of {@link ProxyChatCompletions}: Braintrust's REST API
 * with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * const openai = yield* Braintrust.AiSecret("OpenAI", {
 *   type: "openai",
 *   secret: Config.Redacted("OPENAI_API_KEY"),
 * });
 * const chat = yield* Braintrust.ProxyChatCompletions(openai).pipe(
 *   Effect.provide(Braintrust.ProxyChatCompletionsHttp),
 * );
 * ```
 *
 * @layer
 * @product AiSecret
 * @provides Braintrust.ProxyChatCompletions
 */
export const ProxyChatCompletionsHttp = Layer.succeed(
  ProxyChatCompletions,
  makeHttpBinding({
    id: aiSecretId,
    grants: [AI_SECRET_READ],
    client:
      (auth): ProxyChatCompletionsClient =>
      (request) =>
        auth.authorize(braintrust.createProxyChatCompletion(request)),
  }),
);
