import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { AI_SECRET_READ, aiSecretId } from "./internal/ProxyHttp.ts";
import { ProxyCompletions, type ProxyCompletionsClient } from "./ProxyCompletions.ts";

/**
 * HTTP implementation of {@link ProxyCompletions}: Braintrust's REST API
 * with the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const openai = yield* Braintrust.AiSecret("OpenAI", {
 *     type: "openai",
 *     secret: Config.Redacted("OPENAI_API_KEY"),
 *   });
 *   const complete = yield* Braintrust.ProxyCompletions(openai);
 *   // ...
 * }).pipe(Effect.provide(Braintrust.ProxyCompletionsHttp))
 * ```
 *
 * @layer
 * @product AiSecret
 * @provides Braintrust.ProxyCompletions
 */
export const ProxyCompletionsHttp = Layer.succeed(
  ProxyCompletions,
  makeHttpBinding({
    id: aiSecretId,
    grants: [AI_SECRET_READ],
    client:
      (auth): ProxyCompletionsClient =>
      (request) =>
        auth.authorize(braintrust.createProxyCompletion(request)),
  }),
);
