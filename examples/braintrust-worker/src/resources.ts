import * as Braintrust from "@alchemy.run/braintrust";
import * as Effect from "effect/Effect";

export const Support = Braintrust.Project("Support", {
  description: "Support tickets triaged by the braintrust-worker example.",
});

/** Every triaged ticket, with the queue it was sent to as the expected answer. */
export const Tickets = Effect.gen(function* () {
  const project = yield* Support;
  return yield* Braintrust.Dataset("Tickets", { projectId: project.projectId });
});

/** Picks the queue for a question. Runs in Braintrust, not in the Worker. */
export const Classify = Effect.gen(function* () {
  const project = yield* Support;
  return yield* Braintrust.Function("Classify", {
    projectId: project.projectId,
    functionType: "task",
    functionData: {
      type: "code",
      data: {
        type: "inline",
        runtime_context: { runtime: "node", version: "20" },
        code: "function handler(input) { return /invoice|refund|charge/i.test(input) ? 'billing' : 'general'; }",
      },
    },
  });
});
