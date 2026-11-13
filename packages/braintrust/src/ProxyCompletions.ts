import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AiSecret } from "./AiSecret.ts";

/** An OpenAI completions body: `model`, `prompt`, and the rest of OpenAI's parameters. */
export interface ProxyCompletionsRequest {
  readonly model: string;
  /** Streaming isn't supported. */
  readonly stream?: false;
  readonly [key: string]: unknown;
}

/** Call a completions model through Braintrust's AI proxy, in OpenAI's legacy completions format. Returns the provider's response body. */
export type ProxyCompletionsClient = (
  request: ProxyCompletionsRequest,
) => Effect.Effect<unknown, braintrust.CreateProxyCompletionError, RuntimeContext>;

/**
 * Call a completions model through Braintrust's AI proxy, in OpenAI's legacy
 * completions format. The proxy picks the provider from `model` and uses the
 * bound AI secret's key.
 *
 * The host gets its own Braintrust service account and token, with `read` on
 * this AI secret only, so the proxy can use this provider key and no other.
 * Braintrust has no workload identity, so the token is created at deploy and
 * bound into the host as a secret; destroying the host revokes it.
 *
 * `stream: true` isn't supported; responses are parsed as JSON.
 *
 * ### Calling a completions model
 * **Example:** ProxyCompletions from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const complete = yield* Braintrust.ProxyCompletions(openai);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const completion = yield* complete({ model: "gpt-3.5-turbo-instruct", prompt: question });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.ProxyCompletionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product AiSecret
 */
export interface ProxyCompletions extends Binding.Service<
  ProxyCompletions,
  "Braintrust.ProxyCompletions",
  (secret: AiSecret) => Effect.Effect<ProxyCompletionsClient>
> {}

export const ProxyCompletions = Binding.Service<ProxyCompletions>("Braintrust.ProxyCompletions");
