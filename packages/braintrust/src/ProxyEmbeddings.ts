import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AiSecret } from "./AiSecret.ts";

/** An OpenAI embeddings body: `model`, `input`, and the rest of OpenAI's parameters. */
export interface ProxyEmbeddingsRequest {
  readonly model: string;
  /** Streaming isn't supported. */
  readonly stream?: false;
  readonly [key: string]: unknown;
}

/** Create embeddings through Braintrust's AI proxy, in OpenAI's embeddings format. Returns the provider's response body. */
export type ProxyEmbeddingsClient = (
  request: ProxyEmbeddingsRequest,
) => Effect.Effect<unknown, braintrust.CreateProxyEmbeddingError, RuntimeContext>;

/**
 * Create embeddings through Braintrust's AI proxy, in OpenAI's embeddings
 * format. The proxy picks the provider from `model` and uses the bound AI
 * secret's key.
 *
 * The host gets its own Braintrust service account and token, with `read` on
 * this AI secret only, so the proxy can use this provider key and no other.
 * Braintrust has no workload identity, so the token is created at deploy and
 * bound into the host as a secret; destroying the host revokes it.
 *
 * `stream: true` isn't supported; responses are parsed as JSON.
 *
 * ### Creating embeddings
 * **Example:** ProxyEmbeddings from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const openai = yield* Braintrust.AiSecret("OpenAI", {
 *       type: "openai",
 *       secret: Config.Redacted("OPENAI_API_KEY"),
 *     });
 *     const embed = yield* Braintrust.ProxyEmbeddings(openai);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const question = yield* request.text;
 *         const embedding = yield* embed({ model: "text-embedding-3-small", input: question });
 *         return yield* HttpServerResponse.json(embedding);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.ProxyEmbeddingsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product AiSecret
 */
export interface ProxyEmbeddings extends Binding.Service<
  ProxyEmbeddings,
  "Braintrust.ProxyEmbeddings",
  (secret: AiSecret) => Effect.Effect<ProxyEmbeddingsClient>
> {}

export const ProxyEmbeddings = Binding.Service<ProxyEmbeddings>("Braintrust.ProxyEmbeddings");
