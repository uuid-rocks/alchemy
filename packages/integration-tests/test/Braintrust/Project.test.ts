import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Drift from "alchemy/Drift";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { testName } from "../names.ts";
import { eventually, expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:project", "live"];

const getProject = (projectId: string) => braintrust.getProject({ project_id: projectId });

const expectProjectGone = (projectId: string) =>
  Effect.gen(function* () {
    const exists = yield* getProject(projectId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

test.provider(
  "create a project, update its description and settings in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = yield* stack.deploy(Braintrust.Project("Project", { description: "first" }));
      expect(project.name).toMatch(/^braintrust-project-.*[a-z2-7]{16}$/);
      const created = yield* getProject(project.projectId);
      expect(created.name).toBe(project.name);
      expect(created.description).toBe("first");
      expect(created.org_id).toBe(project.orgId);
      yield* expectFound(Braintrust.Project.lookup({ name: project.name }), project);

      // An unchanged redeploy plans nothing.
      const plan = yield* stack.plan(Braintrust.Project("Project", { description: "first" }));
      expect(plan.resources.Project.action).toBe("noop");

      const updated = yield* stack.deploy(
        Braintrust.Project("Project", {
          description: "second",
          settings: { comparisonKey: "metadata.case_id", blindReviews: true },
        }),
      );
      expect(updated.projectId).toBe(project.projectId);
      yield* eventually(getProject(project.projectId), (observed) => {
        expect(observed.description).toBe("second");
        expect(observed.settings?.comparison_key).toBe("metadata.case_id");
        expect(observed.settings?.blind_reviews).toBe(true);
      });

      // Removing the description and a setting clears them; the rest stays.
      const cleared = yield* stack.deploy(
        Braintrust.Project("Project", { settings: { comparisonKey: "metadata.case_id" } }),
      );
      expect(cleared.projectId).toBe(project.projectId);
      expect(cleared.description).toBeUndefined();
      yield* eventually(getProject(project.projectId), (after) => {
        expect(after.description ?? undefined).toBeUndefined();
        expect(after.settings?.comparison_key).toBe("metadata.case_id");
        expect(after.settings?.blind_reviews ?? undefined).toBeUndefined();
      });

      yield* stack.destroy();
      yield* expectProjectGone(project.projectId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "manage every project setting and reset removed ones",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      // Deleted with the project on destroy.
      const baseline = yield* braintrust.createExperiment({
        project_id: project.projectId,
        name: testName("alchemy-test-bt-settings-baseline"),
      });

      const settings: Braintrust.ProjectSettings = {
        comparisonKey: "metadata.case_id",
        baselineExperimentId: baseline.id,
        spanFieldOrder: [
          { object_type: "project_logs", column_id: "input", position: "0", layout: "full" },
        ],
        remoteEvalSources: [{ url: "https://example.com/eval", name: "remote" }],
        disableRealtimeQueries: true,
        monitorChartsUseMetricsStart: true,
        codingAgentInsightsDashboard: true,
        blindReviews: true,
        requireAllHumanReviewScores: true,
        userIdFields: [["metadata", "customer_id"]],
        sessionIdFields: [["metadata", "conversation_id"]],
        patternAlertDestinations: [{ type: "webhook", url: "https://example.com/alerts" }],
        patternAlertMention: {
          workspace_id: "T0001",
          mention_user_id: "U0001",
          mention_prompt: "Investigate {{pattern}}",
        },
        defaultPreprocessor: { type: "global", name: "thread" },
      };
      const all = yield* stack.deploy(Braintrust.Project("Project", { settings }));
      expect(all.projectId).toBe(project.projectId);
      yield* eventually(getProject(project.projectId), (observed) => {
        expect(observed.settings).toMatchObject({
          comparison_key: "metadata.case_id",
          baseline_experiment_id: baseline.id,
          spanFieldOrder: settings.spanFieldOrder,
          remote_eval_sources: settings.remoteEvalSources,
          disable_realtime_queries: true,
          monitor_charts_use_metrics_start: true,
          coding_agent_insights_dashboard: true,
          blind_reviews: true,
          require_all_human_review_scores: true,
          user_id_fields: settings.userIdFields,
          session_id_fields: settings.sessionIdFields,
          pattern_alert_destinations: settings.patternAlertDestinations,
          pattern_alert_mention: settings.patternAlertMention,
          // Sent as a preprocessor: Braintrust would store a `scorer` and
          // then refuse every later settings write.
          default_preprocessor: { type: "global", name: "thread", function_type: "preprocessor" },
        });
      });
      const plan = yield* stack.plan(Braintrust.Project("Project", { settings }));
      expect(plan.resources.Project.action).toBe("noop");
      const detect = () => Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect((yield* detect()).resources.Project?.action).toBe("unchanged");

      const reset = yield* stack.deploy(
        Braintrust.Project("Project", { settings: { comparisonKey: "metadata.case_id" } }),
      );
      expect(reset.settings).toEqual({ comparisonKey: "metadata.case_id" });
      yield* eventually(getProject(project.projectId), (after) => {
        const { comparison_key, ...rest } = after.settings as Record<string, unknown>;
        expect(comparison_key).toBe("metadata.case_id");
        expect(Object.values(rest).filter((value) => value != null)).toEqual([]);
      });

      yield* stack.destroy();
      yield* expectProjectGone(project.projectId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "drift restores managed settings and project group memberships",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { project, groupId } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Braintrust.ProjectGroup("Group", {});
          const project = yield* Braintrust.Project("Project", {
            settings: { blindReviews: true },
            projectGroupIds: [group.projectGroupId],
          });
          return { project, groupId: group.projectGroupId };
        }),
      );
      expect(project.settings?.blindReviews).toBe(true);
      expect(project.projectGroupIds).toEqual([groupId]);
      const detect = () => Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect((yield* detect()).resources.Project?.action).toBe("unchanged");

      // Out of band, as someone would in the Braintrust UI.
      yield* braintrust.updateProject({ project_id: project.projectId, settings: {} });
      yield* braintrust.updateProjectGroup({
        project_group_id: groupId,
        remove_member_projects: [project.projectId],
      });
      yield* eventually(detect(), (drift) => {
        expect(drift.resources.Project?.action).toBe("drifted");
      });

      const repaired = yield* Drift.repair(stack).pipe(Effect.provide(stack.state));
      expect(repaired.resources.Project?.action).toBe("repaired");
      yield* eventually(getProject(project.projectId), (observed) => {
        expect(observed.settings?.blind_reviews).toBe(true);
      });
      expect(
        (yield* braintrust.getProjectGroup({ project_group_id: groupId })).member_projects,
      ).toEqual([project.projectId]);

      yield* stack.destroy();
      yield* expectProjectGone(project.projectId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an explicitly named project keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const first = testName("alchemy-test-bt-project-a");
      const second = testName("alchemy-test-bt-project-b");

      const project = yield* stack.deploy(Braintrust.Project("Named", { name: first }));
      expect(project.name).toBe(first);

      const renamed = yield* stack.deploy(Braintrust.Project("Named", { name: second }));
      expect(renamed.projectId).toBe(project.projectId);
      expect(renamed.name).toBe(second);
      yield* eventually(getProject(project.projectId), (observed) => {
        expect(observed.name).toBe(second);
      });
      yield* expectFound(Braintrust.Project.lookup({ name: second }), renamed);

      yield* stack.destroy();
      yield* expectProjectGone(project.projectId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a project with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-project");
      // POST returns the existing project of that name, so a leftover from
      // an interrupted run is reused rather than duplicated.
      const foreign = yield* braintrust.createProject({ name });

      const app = (allow: boolean) =>
        Braintrust.Project("Foreign", { name, description: "adopted" }).pipe(adopt(allow));

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.projectId).toBe(foreign.id);
      yield* eventually(getProject(foreign.id), (observed) => {
        expect(observed.description).toBe("adopted");
      });

      yield* stack.destroy();
      yield* expectProjectGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
