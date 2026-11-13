import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { testName } from "../names.ts";
import { eventually, expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:project-automation", "live"];

const retention = (days: number) =>
  ({
    event_type: "retention",
    object_type: "project_logs",
    retention_days: days,
  }) satisfies Braintrust.ProjectAutomationProps["config"];

const webhook = {
  event_type: "logs",
  btql_filter: "error IS NOT NULL",
  interval_seconds: 3600,
  action: { type: "webhook", url: "https://example.com/alchemy-test-hook" },
} satisfies Braintrust.ProjectAutomationProps["config"];

const getAutomation = (projectAutomationId: string) =>
  braintrust.getProjectAutomation({ project_automation_id: projectAutomationId });

const expectAutomationGone = (projectAutomationId: string) =>
  Effect.gen(function* () {
    const exists = yield* getAutomation(projectAutomationId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

type Props = Omit<Braintrust.ProjectAutomationProps, "projectId">;

const inProject = (props: Props) =>
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Project", {});
    return yield* Braintrust.ProjectAutomation("Automation", {
      projectId: project.projectId,
      ...props,
    });
  });

test.provider(
  "create a project automation, update and clear its fields in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first: Props = { description: "first", config: retention(30) };
      const automation = yield* stack.deploy(inProject(first));
      const created = yield* getAutomation(automation.projectAutomationId);
      expect(created.name).toBe(automation.name);
      expect(created.project_id).toBe(automation.projectId);
      expect(created.description).toBe("first");
      expect(created.config).toEqual(retention(30));
      yield* expectFound(
        Braintrust.ProjectAutomation.lookup({
          projectId: automation.projectId,
          name: automation.name,
        }),
        automation,
      );

      const plan = yield* stack.plan(inProject(first));
      expect(plan.resources.Automation.action).toBe("noop");

      // Changing the config leaves the description as deployed.
      yield* stack.deploy(inProject({ ...first, config: retention(90) }));
      const afterConfig = yield* getAutomation(automation.projectAutomationId);
      expect(afterConfig.config).toEqual(retention(90));
      expect(afterConfig.description).toBe("first");

      // Switching to another kind of automation keeps the same id.
      const alert = yield* stack.deploy(inProject({ config: webhook }));
      expect(alert.projectAutomationId).toBe(automation.projectAutomationId);
      expect(alert.description).toBeUndefined();
      yield* eventually(getAutomation(automation.projectAutomationId), (after) => {
        expect(after.config).toEqual(webhook);
        expect(after.description || undefined).toBeUndefined();
      });

      const replan = yield* stack.plan(inProject({ config: webhook }));
      expect(replan.resources.Automation.action).toBe("noop");

      yield* stack.destroy();
      yield* expectAutomationGone(automation.projectAutomationId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "moving a project automation to another project replaces it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both projects stay deployed across the replacement.
      const program = (target: "A" | "B") =>
        Effect.gen(function* () {
          const a = yield* Braintrust.Project("A", {});
          const b = yield* Braintrust.Project("B", {});
          return yield* Braintrust.ProjectAutomation("Moving", {
            projectId: target === "A" ? a.projectId : b.projectId,
            config: retention(30),
          });
        });

      const first = yield* stack.deploy(program("A"));
      const moved = yield* stack.deploy(program("B"));
      expect(moved.projectAutomationId).not.toBe(first.projectAutomationId);
      yield* eventually(getAutomation(moved.projectAutomationId), (observed) => {
        expect(observed.project_id).toBe(moved.projectId);
      });
      yield* expectAutomationGone(first.projectAutomationId);

      yield* stack.destroy();
      yield* expectAutomationGone(moved.projectAutomationId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an explicitly named project automation keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const automation = yield* stack.deploy(
        inProject({ name: testName("alchemy-test-bt-automation-a"), config: retention(30) }),
      );
      const renamed = yield* stack.deploy(
        inProject({ name: testName("alchemy-test-bt-automation-b"), config: retention(30) }),
      );
      expect(renamed.projectAutomationId).toBe(automation.projectAutomationId);
      yield* eventually(getAutomation(automation.projectAutomationId), (observed) => {
        expect(observed.name).toBe(testName("alchemy-test-bt-automation-b"));
      });

      yield* stack.destroy();
      yield* expectAutomationGone(automation.projectAutomationId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a project automation with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-automation");

      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      const foreign = yield* braintrust.createProjectAutomation({
        project_id: project.projectId,
        name,
        config: retention(7),
      });

      const app = (allow: boolean) => inProject({ name, config: retention(14) }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.projectAutomationId).toBe(foreign.id);
      yield* eventually(getAutomation(foreign.id), (observed) => {
        expect(observed.config).toEqual(retention(14));
      });

      yield* stack.destroy();
      yield* expectAutomationGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
