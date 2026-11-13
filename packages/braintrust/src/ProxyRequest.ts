import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AiSecret } from "./AiSecret.ts";

/** An OpenAI API path after `/v1/` (e.g. `responses`), and its JSON body. */
export interface ProxyRequestRequest {
  readonly path: string;
  /** Streaming isn't supported. */
  readonly stream?: false;
  readonly [key: string]: unknown;
}

/** Send an OpenAI API request through Braintrust's AI proxy. Returns the provider's response body. */
export type ProxyRequestClient = (
  request: ProxyRequestRequest,
) => Effect.Effect<unknown, braintrust.CreateProxyError, RuntimeContext>;

/**
 * Send any other OpenAI API request through Braintrust's AI proxy: `path` is
 * the OpenAI path after `/v1/`, and the rest of the request is its JSON
 * body.
 *
 * The host gets its own Braintrust service account and token, with `read` on
 * this AI secret only, so the proxy can use this provider key and no other.
 * Braintrust has no workload identity, so the token is created at deploy and
 * bound into the host as a secret; destroying the host revokes it.
 *
 * `stream: true` isn't supported; responses are parsed as JSON.
 *
 * ### Calling another endpoint
 * **Example:** OpenAI's Responses API through the proxy
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const proxy = yield* Braintrust.ProxyRequest(openai);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const response = yield* proxy({ path: "responses", model: "gpt-4.1-mini", input: question });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.ProxyRequestHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product AiSecret
 */
export interface ProxyRequest extends Binding.Service<
  ProxyRequest,
  "Braintrust.ProxyRequest",
  (secret: AiSecret) => Effect.Effect<ProxyRequestClient>
> {}

export const ProxyRequest = Binding.Service<ProxyRequest>("Braintrust.ProxyRequest");
