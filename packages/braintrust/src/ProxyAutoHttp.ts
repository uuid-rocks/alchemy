import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import { ProxyAuto, type ProxyAutoClient } from "./ProxyAuto.ts";
import { AI_SECRET_READ, aiSecretId } from "./ProxyHttp.ts";

/**
 * HTTP implementation of {@link ProxyAuto}: Braintrust's REST API with the
 * host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * const openai = yield* Braintrust.AiSecret("OpenAI", {
 *   type: "openai",
 *   secret: Config.Redacted("OPENAI_API_KEY"),
 * });
 * const call = yield* Braintrust.ProxyAuto(openai).pipe(
 *   Effect.provide(Braintrust.ProxyAutoHttp),
 * );
 * ```
 *
 * @layer
 * @product AiSecret
 * @provides Braintrust.ProxyAuto
 */
export const ProxyAutoHttp = Layer.succeed(
  ProxyAuto,
  makeHttpBinding({
    id: aiSecretId,
    grants: [AI_SECRET_READ],
    client:
      (auth): ProxyAutoClient =>
      (request) =>
        auth.authorize(braintrust.createProxyAuto(request)),
  }),
);
