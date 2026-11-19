import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { testName } from "../names.ts";
import { eventually, expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:prompt", "live"];

const getPrompt = (promptId: string) => braintrust.getPrompt({ prompt_id: promptId });

const expectPromptGone = (promptId: string) =>
  Effect.gen(function* () {
    const exists = yield* getPrompt(promptId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

const chat = (
  content: string,
  options: braintrust.PromptOptionsNullish = { model: "gpt-4o-mini", params: { temperature: 0 } },
): braintrust.PromptDataNullish => ({
  prompt: { type: "chat", messages: [{ role: "system", content }] },
  options,
});

const inProject = (props: Omit<Braintrust.PromptProps, "projectId">) =>
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Project", {});
    return yield* Braintrust.Prompt("Prompt", { projectId: project.projectId, ...props });
  });

test.provider(
  "create a prompt, write a version only when it changes, clear its fields, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first: Omit<Braintrust.PromptProps, "projectId"> = {
        promptData: chat("first"),
        description: "first",
        tags: ["a", "b"],
      };
      const prompt = yield* stack.deploy(inProject(first));
      yield* eventually(getPrompt(prompt.promptId), (created) => {
        expect(created.slug).toBe(prompt.slug);
        expect(created.name).toBe(prompt.slug);
        expect(created.project_id).toBe(prompt.projectId);
        expect(created.description).toBe("first");
        expect(created.tags).toEqual(["a", "b"]);
        expect(created.prompt_data).toMatchObject(chat("first"));
      });
      yield* expectFound(
        Braintrust.Prompt.lookup({ projectId: prompt.projectId, slug: prompt.slug }),
        prompt,
      );

      const plan = yield* stack.plan(inProject(first));
      expect(plan.resources.Prompt.action).toBe("noop");

      // A forced redeploy runs reconcile against an unchanged prompt; a
      // write would append a version.
      const forced = yield* stack.deploy(inProject(first), { force: true });
      expect(forced.promptId).toBe(prompt.promptId);
      expect(forced.version).toBe(prompt.version);

      // Changing the prompt leaves the other fields as deployed.
      const reworded = yield* stack.deploy(inProject({ ...first, promptData: chat("second") }));
      expect(reworded.promptId).toBe(prompt.promptId);
      expect(reworded.version).not.toBe(prompt.version);
      yield* eventually(getPrompt(prompt.promptId), (observed) => {
        expect(observed.prompt_data).toMatchObject(chat("second"));
        expect(observed.description).toBe("first");
        expect(observed.tags).toEqual(["a", "b"]);
      });

      // The prompt is written whole: the removed `params` are gone, not
      // merged back from the previous version.
      const cleared = yield* stack.deploy(
        inProject({ promptData: chat("second", { model: "gpt-4o-mini" }) }),
      );
      expect(cleared.promptId).toBe(prompt.promptId);
      yield* eventually(getPrompt(prompt.promptId), (after) => {
        expect(after.prompt_data?.options?.params ?? undefined).toBeUndefined();
        expect(after.description || undefined).toBeUndefined();
        expect(after.tags ?? []).toEqual([]);
      });

      yield* stack.destroy();
      yield* expectPromptGone(prompt.promptId);
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "an empty description writes no new version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const props = { promptData: chat("empty"), description: "" };
      const prompt = yield* stack.deploy(inProject(props));
      const forced = yield* stack.deploy(inProject(props), { force: true });
      expect(forced.version).toBe(prompt.version);

      yield* stack.destroy();
      yield* expectPromptGone(prompt.promptId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "removing a null constraint from the response schema writes a new version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const withAnswer = (answer: Record<string, unknown>) =>
        inProject({
          promptData: chat("schema", {
            model: "gpt-4o-mini",
            params: {
              response_format: {
                type: "json_schema",
                json_schema: { name: "answer", schema: { properties: { answer } } },
              },
            },
          }),
        });

      const constrained = yield* stack.deploy(withAnswer({ const: null }));
      const relaxed = yield* stack.deploy(withAnswer({}));
      expect(relaxed.version).not.toBe(constrained.version);
      yield* eventually(getPrompt(constrained.promptId), (observed) => {
        expect(observed.prompt_data?.options?.params).toMatchObject({
          response_format: { json_schema: { schema: { properties: { answer: {} } } } },
        });
        expect(JSON.stringify(observed.prompt_data)).not.toContain('"const"');
      });

      yield* stack.destroy();
      yield* expectPromptGone(constrained.promptId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a prompt with a function type serves as a scorer",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const promptData: braintrust.PromptDataNullish = {
        ...chat("Is the answer polite? {{output}} Answer Yes or No."),
        parser: { type: "llm_classifier", use_cot: true, choice_scores: { Yes: 1, No: 0 } },
      };
      const scorer = yield* stack.deploy(inProject({ functionType: "scorer", promptData }));
      expect(scorer.functionType).toBe("scorer");
      yield* eventually(getPrompt(scorer.promptId), (observed) => {
        expect(observed.function_type).toBe("scorer");
        expect(observed.prompt_data?.parser).toEqual(promptData.parser);
      });

      const plan = yield* stack.plan(inProject({ functionType: "scorer", promptData }));
      expect(plan.resources.Prompt.action).toBe("noop");

      yield* stack.destroy();
      yield* expectPromptGone(scorer.promptId);
    }),
  { tags, timeout: 120_000 },
);

/** The version of the prompt an environment serves, if any. */
const servedVersion = (projectId: string, promptId: string, environment: string) =>
  Stream.runCollect(braintrust.listPrompts.items({ project_id: projectId, environment })).pipe(
    Effect.map((prompts) => prompts.find((prompt) => prompt.id === promptId)?._xact_id),
  );

/** Two environments, a project, and a prompt assigned to some of them. */
const withEnvironments = (
  pick: ((envs: { a: Input<string>; b: Input<string> }) => Input<string>[]) | undefined,
  content = "environments",
) =>
  Effect.gen(function* () {
    const a = yield* Braintrust.Environment("EnvA", {});
    const b = yield* Braintrust.Environment("EnvB", {});
    const project = yield* Braintrust.Project("Project", {});
    const prompt = yield* Braintrust.Prompt("Prompt", {
      projectId: project.projectId,
      promptData: chat(content),
      environments: pick?.({ a: a.slug, b: b.slug }),
    });
    return { prompt, a: a.slug, b: b.slug };
  });

test.provider(
  "assign a prompt to environments, narrow and remove them, and leave them alone unset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const both = withEnvironments(({ a, b }) => [b, a]);
      const { prompt, a, b } = yield* stack.deploy(both);
      expect(prompt.environments).toEqual([a, b].sort());
      expect(yield* servedVersion(prompt.projectId, prompt.promptId, a)).toBe(prompt.version);
      expect(yield* servedVersion(prompt.projectId, prompt.promptId, b)).toBe(prompt.version);

      const plan = yield* stack.plan(both);
      expect(plan.resources.Prompt.action).toBe("noop");
      const forced = yield* stack.deploy(both, { force: true });
      expect(forced.prompt.version).toBe(prompt.version);

      // A content change moves every listed environment to the new version.
      const { prompt: reworded } = yield* stack.deploy(
        withEnvironments(({ a, b }) => [a, b], "reworded"),
      );
      expect(reworded.version).not.toBe(prompt.version);
      expect(yield* servedVersion(prompt.projectId, prompt.promptId, a)).toBe(reworded.version);
      expect(yield* servedVersion(prompt.projectId, prompt.promptId, b)).toBe(reworded.version);

      // Narrowing to one writes a version only that one follows; the API
      // can't unassign, so the other stays on the previous version.
      const { prompt: narrowed } = yield* stack.deploy(
        withEnvironments(({ a }) => [a], "reworded"),
      );
      expect(narrowed.promptId).toBe(prompt.promptId);
      expect(narrowed.environments).toEqual([a]);
      expect(narrowed.version).not.toBe(reworded.version);
      expect(yield* servedVersion(prompt.projectId, prompt.promptId, a)).toBe(narrowed.version);
      expect(yield* servedVersion(prompt.projectId, prompt.promptId, b)).toBe(reworded.version);

      // Removing `environments` leaves every environment behind.
      const { prompt: removed } = yield* stack.deploy(withEnvironments(undefined, "reworded"));
      expect(removed.environments).toBeUndefined();
      expect(removed.version).not.toBe(narrowed.version);
      expect(yield* servedVersion(prompt.projectId, prompt.promptId, a)).toBe(narrowed.version);

      // Unset, an assignment made elsewhere is left as it is.
      const assigned = yield* braintrust.replacePrompt({
        project_id: prompt.projectId,
        slug: prompt.slug,
        name: prompt.slug,
        prompt_data: chat("reworded"),
        environment_slugs: [b],
      });
      yield* stack.deploy(withEnvironments(undefined, "reworded"));
      // No newer version was written, so `b` still serves the current one.
      yield* eventually(getPrompt(prompt.promptId), (current) => {
        expect(current._xact_id).toBe(assigned._xact_id);
      });
      expect(yield* servedVersion(prompt.projectId, prompt.promptId, b)).toBe(assigned._xact_id);

      yield* stack.destroy();
      yield* expectPromptGone(prompt.promptId);
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "adopting a prompt assigned elsewhere moves only the declared environments",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const slug = testName("alchemy-test-bt-env-prompt");

      const program = (environments: boolean) =>
        Effect.gen(function* () {
          const a = yield* Braintrust.Environment("EnvA", {});
          const b = yield* Braintrust.Environment("EnvB", {});
          const project = yield* Braintrust.Project("Project", {});
          const prompt = environments
            ? yield* Braintrust.Prompt("Prompt", {
                projectId: project.projectId,
                slug,
                promptData: chat("adopted"),
                environments: [b.slug],
              })
            : undefined;
          return { prompt, projectId: project.projectId, a: a.slug, b: b.slug };
        });

      const { projectId, a, b } = yield* stack.deploy(program(false));
      const foreign = yield* braintrust.createPrompt({
        project_id: projectId,
        name: slug,
        slug,
        prompt_data: chat("foreign"),
        environment_slugs: [a],
      });
      expect(yield* servedVersion(projectId, foreign.id, a)).toBe(foreign._xact_id);

      const { prompt } = yield* stack.deploy(program(true).pipe(adopt(true)));
      expect(prompt?.promptId).toBe(foreign.id);
      expect(prompt?.environments).toEqual([b]);
      expect(yield* servedVersion(projectId, foreign.id, b)).toBe(prompt?.version);
      expect(yield* servedVersion(projectId, foreign.id, a)).toBe(foreign._xact_id);

      yield* stack.destroy();
      yield* expectPromptGone(foreign.id);
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "moving a prompt to another project replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both projects stay deployed across the replacement. Project C is
      // created by the deploy that moves the prompt into it.
      const program = (target: "A" | "B" | "C") =>
        Effect.gen(function* () {
          const a = yield* Braintrust.Project("A", {});
          const b = yield* Braintrust.Project("B", {});
          const c = target === "C" ? yield* Braintrust.Project("C", {}) : undefined;
          return yield* Braintrust.Prompt("Moving", {
            projectId: target === "A" ? a.projectId : target === "B" ? b.projectId : c!.projectId,
            promptData: chat("moving"),
          });
        });

      const first = yield* stack.deploy(program("A"));
      const moved = yield* stack.deploy(program("B"));
      expect(moved.promptId).not.toBe(first.promptId);
      expect(moved.projectId).not.toBe(first.projectId);
      yield* eventually(getPrompt(moved.promptId), (observed) => {
        expect(observed.project_id).toBe(moved.projectId);
      });
      yield* expectPromptGone(first.promptId);

      // C's id is unknown at plan time, and apply doesn't diff again, so the
      // plan must already replace the prompt.
      expect((yield* stack.plan(program("C"))).resources.Moving.action).toBe("replace");
      const created = yield* stack.deploy(program("C"));
      expect(created.promptId).not.toBe(moved.promptId);
      yield* expectPromptGone(moved.promptId);

      yield* stack.destroy();
      yield* expectPromptGone(created.promptId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "changing the slug of an explicitly slugged prompt keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const before = testName("alchemy-test-bt-prompt-a");
      const after = testName("alchemy-test-bt-prompt-b");

      const prompt = yield* stack.deploy(inProject({ slug: before, promptData: chat("slug") }));
      expect(prompt.slug).toBe(before);
      const moved = yield* stack.deploy(inProject({ slug: after, promptData: chat("slug") }));
      expect(moved.promptId).toBe(prompt.promptId);
      expect(moved.slug).toBe(after);
      yield* eventually(getPrompt(prompt.promptId), (observed) => {
        expect(observed.slug).toBe(after);
      });
      const underOldSlug = yield* Stream.runCollect(
        braintrust.listPrompts.items({ project_id: prompt.projectId, slug: before }),
      );
      expect(underOldSlug.length).toBe(0);

      yield* stack.destroy();
      yield* expectPromptGone(prompt.promptId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a prompt with an explicit slug created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const slug = testName("alchemy-test-bt-foreign-prompt");

      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      const foreign = yield* braintrust.createPrompt({
        project_id: project.projectId,
        name: slug,
        slug,
        prompt_data: chat("foreign"),
      });

      const app = (allow: boolean) =>
        inProject({ slug, promptData: chat("adopted") }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.promptId).toBe(foreign.id);
      yield* eventually(getPrompt(foreign.id), (observed) => {
        expect(observed.prompt_data).toMatchObject(chat("adopted"));
      });

      yield* stack.destroy();
      yield* expectPromptGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a prompt that doesn't exist reads as gone, deletes cleanly, and fails a lookup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      const missing = "00000000-0000-4000-8000-000000000000";

      // The tag the provider's read and delete treat as gone.
      const read = yield* getPrompt(missing).pipe(Effect.flip);
      expect(read._tag).toBe("NotFoundOrForbidden");
      const deleted = yield* braintrust.deletePrompt({ prompt_id: missing }).pipe(Effect.flip);
      expect(deleted._tag).toBe("NotFoundOrForbidden");

      const lookup = Braintrust.Prompt.lookup({
        projectId: project.projectId,
        slug: "alchemy-test-bt-missing-prompt",
      });
      const probe = Core.scratchStack(
        { providers: Braintrust.providers() },
        "BraintrustLookupProbe",
      );
      const lookupMissed = yield* probe
        .plan(
          Braintrust.Project("lookup-probe", {
            // Resolving the attribute runs the lookup.
            description: lookup.promptId,
          }),
        )
        .pipe(
          Effect.map(() => false),
          Effect.catchDefect((defect) =>
            Predicate.isTagged(defect, "LookupNotFoundError")
              ? Effect.succeed(true)
              : Effect.die(defect),
          ),
        );
      expect(lookupMissed).toBe(true);

      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
