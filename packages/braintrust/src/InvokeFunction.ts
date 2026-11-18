import type * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Function } from "./Function.ts";
import type { Prompt } from "./Prompt.ts";

/**
 * Braintrust's `invokeFunction` request, without `function_id`, and without
 * `stream`: responses are parsed as JSON.
 */
export interface InvokeFunctionRequest extends Omit<
  braintrust.InvokeFunctionRequest,
  "function_id" | "stream"
> {}

/** Run the bound function or prompt and return its result. */
export type InvokeFunctionClient = (
  request?: InvokeFunctionRequest,
) => Effect.Effect<
  braintrust.InvokeFunctionResponse,
  braintrust.InvokeFunctionError,
  RuntimeContext
>;

/**
 * Run a Braintrust function (a tool, scorer or task) or prompt and return
 * its result. Calls take no `function_id`: the function is fixed by
 * `InvokeFunction(fn)`. Pass `version` to run an earlier version and
 * `parent` to attach the call to a trace.
 *
 * The host gets its own Braintrust service account and token, with `read` on
 * this function or prompt only. A prompt or LLM scorer calls its model
 * through the AI proxy as that account, so also bind one of the proxy
 * bindings (`Braintrust.ProxyChatCompletions(secret)`) for the AI secret it
 * uses. Braintrust has no workload identity, so the token is created at
 * deploy and bound into the host as a secret; destroying the host revokes
 * it.
 *
 * `stream: true` isn't supported; responses are parsed as JSON.
 *
 * ### Running a function
 * **Example:** InvokeFunction from a Worker
 * ```typescript
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const project = yield* Braintrust.Project("Support", {});
 *     const classify = yield* Braintrust.Function("Classify", {
 *       projectId: project.projectId,
 *       functionType: "task",
 *       functionData: {
 *         type: "code",
 *         data: {
 *           type: "inline",
 *           runtime_context: { runtime: "node", version: "20" },
 *           code: "function handler(input) { return input.includes('invoice') ? 'billing' : 'general'; }",
 *         },
 *       },
 *     });
 *     const invoke = yield* Braintrust.InvokeFunction(classify);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const question = yield* request.text;
 *         const queue = yield* invoke({ input: question });
 *         return yield* HttpServerResponse.json({ queue });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Braintrust.InvokeFunctionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Function
 */
export interface InvokeFunction extends Binding.Service<
  InvokeFunction,
  "Braintrust.InvokeFunction",
  (fn: Function | Prompt) => Effect.Effect<InvokeFunctionClient>
> {}

export const InvokeFunction = Binding.Service<InvokeFunction>("Braintrust.InvokeFunction");
