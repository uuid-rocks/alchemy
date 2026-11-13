import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AiSecret } from "./AiSecret.ts";

/** An OpenAI chat completions body: `model`, `messages`, and the rest of OpenAI's parameters. */
export interface ProxyChatCompletionsRequest {
  readonly model: string;
  /** Streaming isn't supported. */
  readonly stream?: false;
  readonly [key: string]: unknown;
}

/** Call a chat model through Braintrust's AI proxy, in OpenAI's chat completions format. Returns the provider's response body. */
export type ProxyChatCompletionsClient = (
  request: ProxyChatCompletionsRequest,
) => Effect.Effect<unknown, braintrust.CreateProxyChatCompletionError, RuntimeContext>;

/**
 * Call a chat model through Braintrust's AI proxy, in OpenAI's chat
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
 * ### Calling a chat model
 * **Example:** ProxyChatCompletions from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const chat = yield* Braintrust.ProxyChatCompletions(openai);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const completion = yield* chat({
 *           model: "gpt-4.1-mini",
 *           messages: [{ role: "user", content: question }],
 *         });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.ProxyChatCompletionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product AiSecret
 */
export interface ProxyChatCompletions extends Binding.Service<
  ProxyChatCompletions,
  "Braintrust.ProxyChatCompletions",
  (secret: AiSecret) => Effect.Effect<ProxyChatCompletionsClient>
> {}

export const ProxyChatCompletions = Binding.Service<ProxyChatCompletions>(
  "Braintrust.ProxyChatCompletions",
);
