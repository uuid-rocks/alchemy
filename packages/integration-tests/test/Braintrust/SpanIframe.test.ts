import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { testName } from "../names.ts";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:span-iframe", "live"];

const getIframe = (spanIframeId: string) =>
  braintrust.getSpanIframe({ span_iframe_id: spanIframeId });

const expectIframeGone = (spanIframeId: string) =>
  Effect.gen(function* () {
    const exists = yield* getIframe(spanIframeId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

const inProject = (props: Omit<Braintrust.SpanIframeProps, "projectId">) =>
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Project", {});
    return yield* Braintrust.SpanIframe("Iframe", { projectId: project.projectId, ...props });
  });

test.provider(
  "create a span iframe, update and clear its fields in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = {
        url: "https://example.com/first",
        description: "first",
        postMessage: true,
      };
      const iframe = yield* stack.deploy(inProject(first));
      const created = yield* getIframe(iframe.spanIframeId);
      expect(created.name).toBe(iframe.name);
      expect(created.project_id).toBe(iframe.projectId);
      expect(created.url).toBe("https://example.com/first");
      expect(created.description).toBe("first");
      expect(created.post_message).toBe(true);
      yield* expectFound(
        Braintrust.SpanIframe.lookup({ projectId: iframe.projectId, name: iframe.name }),
        iframe,
      );

      const plan = yield* stack.plan(inProject(first));
      expect(plan.resources.Iframe.action).toBe("noop");

      // Changing the URL leaves the other fields as deployed.
      const moved = yield* stack.deploy(inProject({ ...first, url: "https://example.com/second" }));
      expect(moved.spanIframeId).toBe(iframe.spanIframeId);
      const afterUrl = yield* getIframe(iframe.spanIframeId);
      expect(afterUrl.url).toBe("https://example.com/second");
      expect(afterUrl.description).toBe("first");
      expect(afterUrl.post_message).toBe(true);

      const cleared = yield* stack.deploy(inProject({ url: "https://example.com/second" }));
      expect(cleared.spanIframeId).toBe(iframe.spanIframeId);
      expect(cleared.description).toBeUndefined();
      expect(cleared.postMessage).toBe(false);
      const after = yield* getIframe(iframe.spanIframeId);
      expect(after.description || undefined).toBeUndefined();
      expect(after.post_message ?? false).toBe(false);

      yield* stack.destroy();
      yield* expectIframeGone(iframe.spanIframeId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "moving a span iframe to another project replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both projects stay deployed across the replacement.
      const program = (target: "A" | "B") =>
        Effect.gen(function* () {
          const a = yield* Braintrust.Project("A", {});
          const b = yield* Braintrust.Project("B", {});
          return yield* Braintrust.SpanIframe("Moving", {
            projectId: target === "A" ? a.projectId : b.projectId,
            url: "https://example.com/span",
          });
        });

      const first = yield* stack.deploy(program("A"));
      const moved = yield* stack.deploy(program("B"));
      expect(moved.spanIframeId).not.toBe(first.spanIframeId);
      expect((yield* getIframe(moved.spanIframeId)).project_id).toBe(moved.projectId);
      yield* expectIframeGone(first.spanIframeId);

      yield* stack.destroy();
      yield* expectIframeGone(moved.spanIframeId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an explicitly named span iframe keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const url = "https://example.com/span";

      const iframe = yield* stack.deploy(
        inProject({ name: testName("alchemy-test-bt-iframe-a"), url }),
      );
      const renamed = yield* stack.deploy(
        inProject({ name: testName("alchemy-test-bt-iframe-b"), url }),
      );
      expect(renamed.spanIframeId).toBe(iframe.spanIframeId);
      expect((yield* getIframe(iframe.spanIframeId)).name).toBe(
        testName("alchemy-test-bt-iframe-b"),
      );

      yield* stack.destroy();
      yield* expectIframeGone(iframe.spanIframeId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a span iframe with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-iframe");

      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      const foreign = yield* braintrust.createSpanIframe({
        project_id: project.projectId,
        name,
        url: "https://example.com/foreign",
      });

      const app = (allow: boolean) =>
        inProject({ name, url: "https://example.com/adopted" }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.spanIframeId).toBe(foreign.id);
      expect((yield* getIframe(foreign.id)).url).toBe("https://example.com/adopted");

      yield* stack.destroy();
      yield* expectIframeGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
