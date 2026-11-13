import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeHttpBinding } from "./BraintrustBindings.ts";
import type { Function } from "./Function.ts";
import { InvokeFunction, type InvokeFunctionClient } from "./InvokeFunction.ts";
import type { Prompt } from "./Prompt.ts";

/**
 * HTTP implementation of {@link InvokeFunction}: Braintrust's REST API with
 * the host's own service token. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Cloudflare Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const classify = yield* Braintrust.InvokeFunction(Classifier);
 *   // ...
 * }).pipe(Effect.provide(Braintrust.InvokeFunctionHttp))
 * ```
 *
 * @layer
 * @product Function
 * @provides Braintrust.InvokeFunction
 */
export const InvokeFunctionHttp = Layer.succeed(
  InvokeFunction,
  makeHttpBinding({
    id: (fn: Function | Prompt) => (fn.Type === "Braintrust.Prompt" ? fn.promptId : fn.functionId),
    // Braintrust's ACLs know functions as prompts.
    grants: [{ objectType: "prompt", permission: "read" }],
    client:
      (auth, id): InvokeFunctionClient =>
      (request = {}) =>
        Effect.flatMap(id, (function_id) =>
          auth.authorize(braintrust.invokeFunction({ ...request, function_id })),
        ),
  }),
);
