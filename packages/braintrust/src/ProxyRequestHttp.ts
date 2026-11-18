import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { AI_SECRET_READ, aiSecretId } from "./ProxyHttp.ts";
import { ProxyRequest, type ProxyRequestClient } from "./ProxyRequest.ts";

/**
 * HTTP implementation of {@link ProxyRequest}: Braintrust's REST API with
 * the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * const openai = yield* Braintrust.AiSecret("OpenAI", {
 *   type: "openai",
 *   secret: Config.Redacted("OPENAI_API_KEY"),
 * });
 * const proxy = yield* Braintrust.ProxyRequest(openai).pipe(
 *   Effect.provide(Braintrust.ProxyRequestHttp),
 * );
 * ```
 *
 * @layer
 * @product AiSecret
 * @provides Braintrust.ProxyRequest
 */
export const ProxyRequestHttp = Layer.succeed(
  ProxyRequest,
  makeHttpBinding({
    id: aiSecretId,
    grants: [AI_SECRET_READ],
    client:
      (auth): ProxyRequestClient =>
      (request) =>
        auth.authorize(braintrust.createProxy(request)),
  }),
);
