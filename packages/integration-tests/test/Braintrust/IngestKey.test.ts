import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import type { InputProps } from "alchemy/Input";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { testName } from "../names.ts";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:ingest-key", "live"];

// There is no get by id; a key exists while its project lists it.
const listedIds = (projectId: string) =>
  Stream.runCollect(braintrust.listIngestKeys.items({ project_id: projectId })).pipe(
    Effect.map((keys) => keys.map((key) => key.id)),
  );

const expectKeyGone = (projectId: string, ingestKeyId: string) =>
  Effect.gen(function* () {
    const ids = yield* listedIds(projectId).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (ids) => !ids.includes(ingestKeyId),
        times: 10,
      }),
    );
    expect(ids).not.toContain(ingestKeyId);
  });

const inProject = (props: InputProps<Omit<Braintrust.IngestKeyProps, "projectId">>) =>
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Project", {});
    return yield* Braintrust.IngestKey("IngestKey", { projectId: project.projectId, ...props });
  });

test.provider(
  "create an ingest key, look it up, and revoke it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const key = yield* stack.deploy(inProject({}));
      expect(yield* listedIds(key.projectId)).toContain(key.ingestKeyId);
      expect(key.previewName.startsWith("bt-ik-")).toBe(true);
      // The URL carries the key, so it is only ever an opaque Redacted.
      expect(Redacted.isRedacted(key.url)).toBe(true);
      const url = key.url ? Redacted.value(key.url) : "";
      expect(url.startsWith("https://")).toBe(true);
      expect(JSON.stringify(key)).not.toContain(url);
      yield* expectFound(
        Braintrust.IngestKey.lookup({ projectId: key.projectId, ingestKeyId: key.ingestKeyId }),
        key,
      );

      const plan = yield* stack.plan(inProject({}));
      expect(plan.resources.IngestKey.action).toBe("noop");

      // An unchanged redeploy keeps the same key.
      const again = yield* stack.deploy(inProject({}));
      expect(again.ingestKeyId).toBe(key.ingestKeyId);

      yield* stack.destroy();
      yield* expectKeyGone(key.projectId, key.ingestKeyId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an ingest key or moving it to another project replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both projects stay deployed across the replacements.
      const program = (target: "A" | "B", name: string) =>
        Effect.gen(function* () {
          const a = yield* Braintrust.Project("A", {});
          const b = yield* Braintrust.Project("B", {});
          return yield* Braintrust.IngestKey("Moving", {
            projectId: target === "A" ? a.projectId : b.projectId,
            name,
          });
        });

      const first = yield* stack.deploy(program("A", testName("alchemy-test-bt-ik-a")));
      const renamed = yield* stack.deploy(program("A", testName("alchemy-test-bt-ik-b")));
      expect(renamed.ingestKeyId).not.toBe(first.ingestKeyId);
      expect(renamed.name).toBe(testName("alchemy-test-bt-ik-b"));
      yield* expectKeyGone(first.projectId, first.ingestKeyId);

      const moved = yield* stack.deploy(program("B", testName("alchemy-test-bt-ik-b")));
      expect(moved.ingestKeyId).not.toBe(renamed.ingestKeyId);
      expect(moved.projectId).not.toBe(renamed.projectId);
      expect(yield* listedIds(moved.projectId)).toContain(moved.ingestKeyId);
      yield* expectKeyGone(renamed.projectId, renamed.ingestKeyId);

      yield* stack.destroy();
      yield* expectKeyGone(moved.projectId, moved.ingestKeyId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "an ingest key with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-ik");

      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      const foreign = yield* braintrust.createIngestKey({ project_id: project.projectId, name });

      const app = (allow: boolean) => inProject({ name }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.ingestKeyId).toBe(foreign.id);

      yield* stack.destroy();
      yield* expectKeyGone(project.projectId, foreign.id);
    }),
  { tags, timeout: 120_000 },
);
