import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Core from "@alchemy.run/test/Core";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";

/**
 * Look a just-deployed resource up from a second stack that only plans,
 * and check its attributes match the ones the deploy returned. The plan
 * resolves the lookup against Braintrust; nothing is written: the probe is a
 * project that doesn't exist, which only reads as missing.
 */
export const expectFound = Effect.fn(function* (
  lookup: Output.Output<unknown> | object,
  expected: object,
) {
  const probe = Core.scratchStack({ providers: Braintrust.providers() }, "BraintrustLookupProbe");
  const plan = yield* probe
    .plan(
      // A create plans without reading `description`.
      Braintrust.Project("lookup-probe", {
        description: Output.map(lookup as Output.Output<unknown>, (attrs) => JSON.stringify(attrs)),
      }),
    )
    .pipe(
      Effect.catchDefect((defect) =>
        Predicate.isTagged(defect, "LookupNotFoundError")
          ? Effect.fail(defect)
          : Effect.die(defect),
      ),
      // A just-created object can list as missing for a few seconds.
      Effect.retry({ times: 6, schedule: Schedule.spaced("2 seconds") }),
    );
  const node = plan.resources["lookup-probe"] as { props: { description: string } };
  expect(JSON.parse(node.props.description)).toEqual(JSON.parse(JSON.stringify(expected)));
});
