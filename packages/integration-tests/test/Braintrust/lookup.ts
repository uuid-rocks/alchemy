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
  read.pipe(
    Effect.repeat({
      until: (value) => passes(check, value),
      schedule: Schedule.spaced("500 millis"),
      times: 9,
    }),
    Effect.tap((value) => Effect.sync(() => check(value))),
  );

const passes = <A>(check: (value: A) => void, value: A) => {
  try {
    check(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * Budget for a test that makes several group, role, ACL or member writes.
 * Braintrust holds every such write while it creates a service token, about
 * 10 s each (measured 2026-11-18: a group PATCH sent during a token create
 * took 9.7 s and returned with it). The suite creates a dozen tokens at once
 * (`Bindings.test.ts`, `ServiceToken.test.ts`), so one write can wait a minute.
 */
export const permissionWritesTimeout = 300_000;
