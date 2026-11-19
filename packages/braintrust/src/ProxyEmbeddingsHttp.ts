import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { AI_SECRET_READ, aiSecretId } from "./internal/ProxyHttp.ts";
import { ProxyEmbeddings, type ProxyEmbeddingsClient } from "./ProxyEmbeddings.ts";

/**
 * HTTP implementation of {@link ProxyEmbeddings}: Braintrust's REST API with
 * the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const openai = yield* Braintrust.AiSecret("OpenAI", {
 *     type: "openai",
 *     secret: Config.Redacted("OPENAI_API_KEY"),
 *   });
 *   const embed = yield* Braintrust.ProxyEmbeddings(openai);
 *   // ...
 * }).pipe(Effect.provide(Braintrust.ProxyEmbeddingsHttp))
 * ```
 *
 * @layer
 * @product AiSecret
 * @provides Braintrust.ProxyEmbeddings
 */
export const ProxyEmbeddingsHttp = Layer.succeed(
  ProxyEmbeddings,
  makeHttpBinding({
    id: aiSecretId,
    grants: [AI_SECRET_READ],
    client:
      (auth): ProxyEmbeddingsClient =>
      (request) =>
        auth.authorize(braintrust.createProxyEmbedding(request)),
  }),
);
