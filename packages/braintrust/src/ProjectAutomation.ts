import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { braintrustName, isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface ProjectAutomationProps {
  /**
   * Id of the project the automation belongs to, e.g. `project.projectId`.
   * Changing it replaces the automation.
   */
  projectId: string;
  /**
   * Automation name, unique within the project. If omitted, a unique name
   * is generated from the stack, stage and logical ID. Renaming updates the
   * automation in place.
   */
  name?: string;
  /** Textual description of the automation. Removing it clears the description. */
  description?: string;
  /**
   * What the automation does, chosen by `event_type`: `logs` (alert a
   * webhook, Slack or PagerDuty when logs match a BTQL filter),
   * `btql_export` (export logs to S3 or GCS), `retention` (delete data
   * older than `retention_days`), `environment_update`, `windowed`,
   * `topic`, `topic_digest` or `async_query`. Replaced as a whole on every
   * change; changing `event_type` updates the automation in place.
   */
  config: braintrust.CreateProjectAutomationRequestConfig;
}

export interface ProjectAutomationAttributes {
  /** Unique identifier of the project automation. */
  projectAutomationId: string;
  /** Id of the project the automation belongs to. */
  projectId: string;
  /** Automation name. */
  name: string;
  /** Textual description of the automation. */
  description: string | undefined;
  /** What the automation does. */
  config: braintrust.ProjectAutomationConfig;
  /** When the automation was created (ISO 8601). */
  created: string | undefined;
}

export type ProjectAutomation = Resource<
  "Braintrust.ProjectAutomation",
  ProjectAutomationProps,
  ProjectAutomationAttributes,
  never,
  Providers,
  ProjectAutomationLookup
>;

/**
 * Props for {@link ProjectAutomation.lookup}: find an automation this stack
 * doesn't manage by its project and name.
 */
export interface ProjectAutomationLookup {
  /** Id of the project the automation belongs to. */
  projectId: string;
  /** Automation name. */
  name: string;
}

/**
 * A Braintrust project automation: a rule that runs on a project's data,
 * such as an alert when logs match a filter, a scheduled export to cloud
 * storage, or a retention policy. See
 * [Automations](https://www.braintrust.dev/docs/guides/automations).
 *
 * Automations carry no labels Alchemy can use for ownership, so an
 * automation found under an explicit `name` with no prior state is refused
 * unless adopted.
 *
 * :::caution
 * Changing `projectId` replaces the automation.
 * :::
 *
 * ### Creating a Project Automation
 * **Example:** Delete logs after 30 days
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const retention = yield* Braintrust.ProjectAutomation("Retention", {
 *   projectId: project.projectId,
 *   config: {
 *     event_type: "retention",
 *     object_type: "project_logs",
 *     retention_days: 30,
 *   },
 * });
 * ```
 *
 * **Example:** Call a webhook when errors are logged
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const alert = yield* Braintrust.ProjectAutomation("ErrorAlert", {
 *   projectId: project.projectId,
 *   name: "Errors",
 *   description: "At most one call an hour",
 *   config: {
 *     event_type: "logs",
 *     btql_filter: "error IS NOT NULL",
 *     interval_seconds: 3600,
 *     action: { type: "webhook", url: "https://hooks.example.com/braintrust" },
 *   },
 * });
 * ```
 *
 * ### Looking up an existing automation
 * **Example:** Reference an automation made in the Braintrust UI
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const automation = Braintrust.ProjectAutomation.lookup({
 *   projectId: project.projectId,
 *   name: "Errors",
 * });
 * ```
 *
 * @resource
 * @product Project Automation
 */
export const ProjectAutomation = Resource<ProjectAutomation>("Braintrust.ProjectAutomation");

const toAttributes = (automation: braintrust.ProjectAutomation): ProjectAutomationAttributes => ({
  projectAutomationId: automation.id,
  projectId: automation.project_id,
  name: automation.name,
  // A PATCH can't null the description, so a cleared one reads back as "".
  description: automation.description || undefined,
  config: automation.config,
  created: automation.created ?? undefined,
});

const getById = (projectAutomationId: string) =>
  braintrust
    .getProjectAutomation({ project_automation_id: projectAutomationId })
    .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined));

// The hosted API refuses the spec's `project_automation_name` filter, and
// the generated request has no project filter, so match client-side.
const findByName = (projectId: string, name: string) =>
  braintrust.listProjectAutomations.items({}).pipe(
    Stream.filter((automation) => automation.project_id === projectId && automation.name === name),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const ProjectAutomationProvider = () =>
  Provider.effect(
    ProjectAutomation,
    Effect.gen(function* () {
      return {
        stables: ["projectAutomationId", "projectId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.projectId !== olds.projectId) return { action: "replace" } as const;
        }),
        lookup: Effect.fn(function* ({ projectId, name }) {
          const automation = yield* findByName(projectId, name);
          return automation ? toAttributes(automation) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const automation = yield* getById(output.projectAutomationId);
            return automation ? toAttributes(automation) : undefined;
          }
          const name = yield* braintrustName(id, olds.name);
          const automation = yield* findByName(olds.projectId, name);
          if (!automation) return undefined;
          const attrs = toAttributes(automation);
          // A generated name carries this instance's suffix, so it is ours.
          return olds.name === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "projectAutomationId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* braintrustName(id, news.name);

          // Observe — by id once we have one (it survives renames), else by name.
          const cached = output ? yield* getById(output.projectAutomationId) : undefined;
          let automation =
            (cached?.project_id === news.projectId ? cached : undefined) ??
            (yield* findByName(news.projectId, name));

          // Ensure — POST returns the existing automation of the same name
          // unchanged, so a concurrent create converges on one.
          if (!automation) {
            yield* session.note(`Creating project automation ${name}...`);
            automation = yield* braintrust.createProjectAutomation({
              project_id: news.projectId,
              name,
              description: news.description,
              config: news.config,
            });
          }

          // Sync — PATCH only the fields that differ from what is deployed.
          // The API ignores `null`; an empty string clears the description.
          // The config is validated and replaced as a whole.
          const update: Omit<braintrust.UpdateProjectAutomationRequest, "project_automation_id"> =
            {};
          if (automation.name !== name) update.name = name;
          if ((automation.description || undefined) !== news.description) {
            update.description = news.description ?? "";
          }
          if (!deepEqual(automation.config, news.config)) update.config = news.config;
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating project automation ${name}...`);
            automation = yield* braintrust.updateProjectAutomation({
              project_automation_id: automation.id,
              ...update,
            });
          }

          return toAttributes(automation);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteProjectAutomation({ project_automation_id: output.projectAutomationId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const automations = yield* Stream.runCollect(braintrust.listProjectAutomations.items({}));
          return automations
            .filter((automation) => isGeneratedName(automation.name))
            .map(toAttributes);
        }),
      };
    }),
  );
