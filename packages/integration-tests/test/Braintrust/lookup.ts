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

/**
 * Read until `check` passes, up to 10 times 500 ms apart, and return the
 * last read. A Braintrust read can return an object as it was before the
 * latest write: in CI, a GET 200 ms after the PATCH that cleared a project's
 * description still returned the old one, though the PATCH response had it
 * cleared. The last attempt's assertion error is the test's failure.
 */
export const eventually = <A, E, R>(read: Effect.Effect<A, E, R>, check: (value: A) => void) =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt < 10; attempt++) {
      const value = yield* read;
      if (passes(check, value)) return value;
      yield* Effect.sleep("500 millis");
    }
    const value = yield* read;
    check(value);
    return value;
  });

const passes = <A>(check: (value: A) => void, value: A) => {
  try {
    check(value);
    return true;
  } catch {
    return false;
  }
};
