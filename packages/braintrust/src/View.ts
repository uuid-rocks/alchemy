import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { braintrustName, isGeneratedName, unlessDeleted } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface ViewProps {
  /**
   * Type of the object the view is saved on, usually `"project"`. Changing
   * it replaces the view.
   */
  objectType: braintrust.AclObjectType;
  /**
   * Id of the object the view is saved on, e.g. `project.projectId`.
   * Changing it replaces the view.
   */
  objectId: string;
  /**
   * The page the view applies to, such as `logs`, `experiments`,
   * `datasets` or `monitor`. Changing it updates the view in place.
   */
  viewType: braintrust.ViewViewType;
  /**
   * View name, unique per object and view type. If omitted, a unique name
   * is generated from the stack, stage and logical ID. Renaming updates the
   * view in place.
   */
  name?: string;
  /** Textual description of the view. Removing it clears the description. */
  description?: string;
  /**
   * The saved search: `filter`, `tag`, `match` and `sort` clauses, and
   * custom charts. Replaced as a whole on every change; removing it clears
   * the view data.
   */
  viewData?: braintrust.ViewData;
  /**
   * Table options (column visibility, order and sizing, grouping, row
   * height, chart axes) or, for `monitor` views, the monitor options.
   * Replaced as a whole on every change; removing it clears the options.
   */
  options?: braintrust.ViewOptions;
}

export interface ViewAttributes {
  /** Unique identifier of the view. */
  viewId: string;
  /** Type of the object the view is saved on. */
  objectType: braintrust.AclObjectType;
  /** Id of the object the view is saved on. */
  objectId: string;
  /** The page the view applies to. */
  viewType: braintrust.ViewViewType;
  /** View name. */
  name: string;
  /** Textual description of the view. */
  description: string | undefined;
  /** The saved search and custom charts. */
  viewData: braintrust.ViewData | undefined;
  /** Table or monitor options. */
  options: braintrust.ViewOptions | undefined;
  /** When the view was created (ISO 8601). */
  created: string | undefined;
}

export type View = Resource<
  "Braintrust.View",
  ViewProps,
  ViewAttributes,
  never,
  Providers,
  ViewLookup
>;

/**
 * Props for {@link View.lookup}: find a view this stack doesn't manage by
 * the object it is saved on, its type and its name.
 */
export interface ViewLookup {
  /** Type of the object the view is saved on, usually `"project"`. */
  objectType: braintrust.AclObjectType;
  /** Id of the object the view is saved on. */
  objectId: string;
  /** The page the view applies to. */
  viewType: braintrust.ViewViewType;
  /** View name. */
  name: string;
}

/**
 * A Braintrust view: a saved filter, sort and column layout for a page such
 * as a project's logs or experiments, shared with everyone in the project.
 * See [Views](https://www.braintrust.dev/docs/guides/logs/view#views).
 *
 * Views carry no labels Alchemy can use for ownership, so a view found
 * under an explicit `name` with no prior state is refused unless adopted.
 *
 * :::caution
 * Changing `objectType` or `objectId` replaces the view.
 * :::
 *
 * ### Creating a View
 * **Example:** Logs view that shows only errors
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const errors = yield* Braintrust.View("Errors", {
 *   objectType: "project",
 *   objectId: project.projectId,
 *   viewType: "logs",
 *   name: "Errors",
 *   viewData: { search: { filter: ["error IS NOT NULL"] } },
 *   options: { columnOrder: ["input", "output", "error"] },
 * });
 * ```
 *
 * ### Looking up an existing view
 * **Example:** Reference a view made in the Braintrust UI
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const view = Braintrust.View.lookup({
 *   objectType: "project",
 *   objectId: project.projectId,
 *   viewType: "logs",
 *   name: "Errors",
 * });
 * ```
 *
 * @resource
 * @product View
 */
export const View = Resource<View>("Braintrust.View");

const isEmpty = (value: object | null | undefined) =>
  value == null || Object.keys(value).length === 0;

const toAttributes = (view: braintrust.View): ViewAttributes => ({
  viewId: view.id,
  objectType: view.object_type,
  objectId: view.object_id,
  viewType: view.view_type,
  name: view.name,
  // A PATCH can't null these fields, so a cleared one reads back empty.
  description: view.description || undefined,
  viewData: isEmpty(view.view_data) ? undefined : (view.view_data ?? undefined),
  options: isEmpty(view.options) ? undefined : (view.options ?? undefined),
  created: view.created ?? undefined,
});

interface Scope {
  objectType: braintrust.AclObjectType;
  objectId: string;
}

const getById = (scope: Scope, viewId: string) =>
  braintrust
    .getView({ view_id: viewId, object_type: scope.objectType, object_id: scope.objectId })
    .pipe(
      Effect.map(unlessDeleted),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined),
    );

// Names are unique per object and view type, not per object.
const findByName = (scope: Scope, viewType: braintrust.ViewViewType, name: string) =>
  braintrust.listViews
    .items({
      object_type: scope.objectType,
      object_id: scope.objectId,
      view_type: viewType,
      view_name: name,
    })
    .pipe(
      Stream.filter(
        (view) =>
          view.object_id === scope.objectId &&
          view.view_type === viewType &&
          view.name === name &&
          !view.deleted_at,
      ),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
    );

export const ViewProvider = () =>
  Provider.effect(
    View,
    Effect.gen(function* () {
      return {
        stables: ["viewId", "objectType", "objectId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.objectType !== olds.objectType || news.objectId !== olds.objectId) {
            return { action: "replace" } as const;
          }
        }),
        lookup: Effect.fn(function* ({ objectType, objectId, viewType, name }) {
          const view = yield* findByName({ objectType, objectId }, viewType, name);
          return view ? toAttributes(view) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const view = yield* getById(output, output.viewId);
            return view ? toAttributes(view) : undefined;
          }
          const view = yield* findByName(olds, olds.viewType, yield* braintrustName(id, olds.name));
          if (!view) return undefined;
          const attrs = toAttributes(view);
          // A generated name carries this instance's suffix, so it is ours.
          return olds.name === undefined ? attrs : unownedUnlessPrevious(attrs, previous, "viewId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* braintrustName(id, news.name);
          const scope = { object_type: news.objectType, object_id: news.objectId };

          // Observe — by id once we have one (it survives renames and view
          // type changes), else by name.
          const cached = output ? yield* getById(news, output.viewId) : undefined;
          let view = cached ?? (yield* findByName(news, news.viewType, name));

          // Ensure — POST returns the existing view of the same name and
          // type unchanged, so a concurrent create converges on one view.
          if (!view) {
            yield* session.note(`Creating view ${name}...`);
            view = yield* braintrust.createView({
              ...scope,
              view_type: news.viewType,
              name,
              description: news.description,
              view_data: news.viewData,
              options: news.options,
            });
          }

          // Sync — PATCH only the fields that differ from what is deployed.
          // The API ignores `null`: an empty string clears the description
          // and `{}` the view data or options, which are replaced as a whole.
          const observed = toAttributes(view);
          const update: Omit<braintrust.UpdateViewRequest, "view_id" | keyof typeof scope> = {};
          if (observed.name !== name) update.name = name;
          if (observed.viewType !== news.viewType) update.view_type = news.viewType;
          if (observed.description !== news.description) {
            update.description = news.description ?? "";
          }
          if (!deepEqual(observed.viewData, isEmpty(news.viewData) ? undefined : news.viewData)) {
            update.view_data = news.viewData ?? {};
          }
          if (!deepEqual(observed.options, isEmpty(news.options) ? undefined : news.options)) {
            update.options = news.options ?? {};
          }
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating view ${name}...`);
            view = yield* braintrust.updateView({ view_id: view.id, ...scope, ...update });
          }

          return toAttributes(view);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteView({
              view_id: output.viewId,
              object_type: output.objectType,
              object_id: output.objectId,
            })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        // Views can only be listed per object, so list those saved on
        // projects Alchemy generated.
        list: Effect.fn(function* () {
          const projects = yield* Stream.runCollect(braintrust.listProjects.items({}));
          const views = yield* Stream.runCollect(
            Stream.fromIterable(
              projects.filter((project) => !project.deleted_at && isGeneratedName(project.name)),
            ).pipe(
              Stream.flatMap((project) =>
                braintrust.listViews.items({ object_type: "project", object_id: project.id }),
              ),
            ),
          );
          return views
            .filter((view) => !view.deleted_at && isGeneratedName(view.name))
            .map(toAttributes);
        }),
      };
    }),
  );
