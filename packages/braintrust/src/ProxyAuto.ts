import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AiSecret } from "./AiSecret.ts";

/** A chat completions or completions body, depending on `model`. */
export interface ProxyAutoRequest {
  readonly model: string;
  /** Streaming isn't supported. */
  readonly stream?: false;
  readonly [key: string]: unknown;
}

/** Call any model through Braintrust's AI proxy, which sends the body as a chat completion or a completion depending on the model. Returns the provider's response body. */
export type ProxyAutoClient = (
  request: ProxyAutoRequest,
) => Effect.Effect<unknown, braintrust.CreateProxyAutoError, RuntimeContext>;

/**
 * Call any model through Braintrust's AI proxy, which sends the body as a
 * chat completion or a completion depending on the model. The proxy picks
 * the provider from `model` and uses the bound AI secret's key.
 *
 * The host gets its own Braintrust service account and token, with `read` on
 * this AI secret only, so the proxy can use this provider key and no other.
 * Braintrust has no workload identity, so the token is created at deploy and
 * bound into the host as a secret; destroying the host revokes it.
 *
 * `stream: true` isn't supported; responses are parsed as JSON.
 *
 * ### Calling a model
 * **Example:** ProxyAuto from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const call = yield* Braintrust.ProxyAuto(openai);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const completion = yield* call({
 *           model: "gpt-4.1-mini",
 *           messages: [{ role: "user", content: question }],
 *         });
 *         return HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.ProxyAutoHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product AiSecret
 */
export interface ProxyAuto extends Binding.Service<
  ProxyAuto,
  "Braintrust.ProxyAuto",
  (secret: AiSecret) => Effect.Effect<ProxyAutoClient>
> {}

export const ProxyAuto = Binding.Service<ProxyAuto>("Braintrust.ProxyAuto");
