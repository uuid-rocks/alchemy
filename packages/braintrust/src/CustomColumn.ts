import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { braintrustName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface CustomColumnProps {
  /**
   * Type of the object the column is scoped to: `"project"` for project
   * logs, experiment spans and the experiments list, `"dataset"` for
   * dataset rows. Changing it replaces the column.
   */
  objectType: braintrust.AclObjectType;
  /**
   * Id of the object the column is scoped to, e.g. `project.projectId` or
   * `dataset.datasetId`. Changing it replaces the column.
   */
  objectId: string;
  /**
   * The child table the column applies to, such as `"project_log"` or
   * `"experiment"`; `""` for the object's own table, such as a dataset's
   * rows. Changing it replaces the column.
   */
  subtype: braintrust.CustomColumnSubtype;
  /**
   * The table variant, for objects with more than one table of the same
   * rows. Set `"experiment_list"` with subtype `"experiment"` to target the
   * experiments list instead of experiment details. Changing it replaces
   * the column.
   * @default subtype, or objectType when subtype is ""
   */
  variant?: braintrust.CustomColumnVariant;
  /**
   * Column name, unique within its table. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Renaming updates the
   * column in place.
   */
  name?: string;
  /** Expression that computes the column's value from each row, e.g. `metadata.model`. */
  expr: string;
}

export interface CustomColumnAttributes {
  /** Unique identifier of the custom column. */
  customColumnId: string;
  /** Type of the object the column is scoped to. */
  objectType: braintrust.AclObjectType;
  /** Id of the object the column is scoped to. */
  objectId: string;
  /** The child table the column applies to. */
  subtype: braintrust.CustomColumnSubtype;
  /** The table variant the column applies to. */
  variant: braintrust.CustomColumnVariant;
  /** Column name. */
  name: string;
  /** Expression that computes the column's value. */
  expr: string;
  /** When the column was created (ISO 8601). */
  created: string | undefined;
}

export type CustomColumn = Resource<
  "Braintrust.CustomColumn",
  CustomColumnProps,
  CustomColumnAttributes,
  never,
  Providers,
  CustomColumnLookup
>;

/**
 * Props for {@link CustomColumn.lookup}: find a column this stack doesn't
 * manage by its table and name.
 */
export interface CustomColumnLookup {
  /** Type of the object the column is scoped to. */
  objectType: braintrust.AclObjectType;
  /** Id of the object the column is scoped to. */
  objectId: string;
  /** The child table the column applies to. */
  subtype: braintrust.CustomColumnSubtype;
  /**
   * The table variant the column applies to.
   * @default subtype, or objectType when subtype is ""
   */
  variant?: braintrust.CustomColumnVariant;
  /** Column name. */
  name: string;
}

/**
 * A Braintrust custom column: a column computed from an expression over
 * each row of a table, such as project logs, experiment spans or dataset
 * rows. See
 * [Custom columns](https://www.braintrust.dev/docs/guides/logs/view#custom-columns).
 *
 * Custom columns carry no labels Alchemy can use for ownership, so a column
 * found under an explicit `name` with no prior state is refused unless
 * adopted.
 *
 * :::caution
 * Changing `objectType`, `objectId`, `subtype` or `variant` replaces the
 * column.
 * :::
 *
 * ### Creating a Custom Column
 * **Example:** Column on a project's logs
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const model = yield* Braintrust.CustomColumn("Model", {
 *   objectType: "project",
 *   objectId: project.projectId,
 *   subtype: "project_log",
 *   name: "Model",
 *   expr: "metadata.model",
 * });
 * ```
 *
 * **Example:** Column on the experiments list
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const commit = yield* Braintrust.CustomColumn("Commit", {
 *   objectType: "project",
 *   objectId: project.projectId,
 *   subtype: "experiment",
 *   variant: "experiment_list",
 *   name: "Commit",
 *   expr: "metadata.commit",
 * });
 * ```
 *
 * **Example:** Column on a dataset's rows
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const dataset = yield* Braintrust.Dataset("Tickets", {
 *   projectId: project.projectId,
 * });
 * const channel = yield* Braintrust.CustomColumn("Channel", {
 *   objectType: "dataset",
 *   objectId: dataset.datasetId,
 *   subtype: "",
 *   name: "Channel",
 *   expr: "metadata.channel",
 * });
 * ```
 *
 * ### Looking up an existing column
 * **Example:** Reference a column made in the Braintrust UI
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const column = Braintrust.CustomColumn.lookup({
 *   objectType: "project",
 *   objectId: project.projectId,
 *   subtype: "project_log",
 *   name: "Model",
 * });
 * ```
 *
 * @resource
 * @product Custom Column
 */
export const CustomColumn = Resource<CustomColumn>("Braintrust.CustomColumn");

const toAttributes = (column: braintrust.CustomColumn): CustomColumnAttributes => ({
  customColumnId: column.id,
  objectType: column.object_type,
  objectId: column.object_id,
  subtype: column.subtype,
  variant: column.variant,
  name: column.name,
  expr: column.expr,
  created: column.created ?? undefined,
});

interface Table {
  objectType: braintrust.AclObjectType;
  objectId: string;
  subtype: braintrust.CustomColumnSubtype;
  variant?: braintrust.CustomColumnVariant;
}

// There is no get by id: columns are read from their table's list, which
// returns every column in one response.
const listTable = (table: Table) =>
  braintrust
    .listColumns({
      object_type: table.objectType,
      object_id: table.objectId,
      subtype: table.subtype,
      variant: table.variant,
    })
    .pipe(Effect.map((response) => response.objects));

// A table whose object is gone has no columns.
const findById = (table: Table, customColumnId: string) =>
  listTable(table).pipe(
    Effect.map((columns) => columns.find((column) => column.id === customColumnId)),
    Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined),
  );

const findByName = (table: Table, name: string) =>
  listTable(table).pipe(
    Effect.map((columns) => columns.find((column) => column.name === name)),
    Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined),
  );

export const CustomColumnProvider = () =>
  Provider.effect(
    CustomColumn,
    Effect.gen(function* () {
      return {
        stables: ["customColumnId", "objectType", "objectId", "subtype", "variant"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.objectType !== olds.objectType ||
            news.objectId !== olds.objectId ||
            news.subtype !== olds.subtype ||
            // Setting the variant Braintrust defaults to is not a change.
            (news.variant ?? (news.subtype || news.objectType)) !==
              (olds.variant ?? (olds.subtype || olds.objectType))
          ) {
            return { action: "replace" } as const;
          }
        }),
        lookup: Effect.fn(function* ({ name, ...table }) {
          const column = yield* findByName(table, name);
          return column ? toAttributes(column) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const column = yield* findById(output, output.customColumnId);
            return column ? toAttributes(column) : undefined;
          }
          const name = yield* braintrustName(id, olds.name);
          const column = yield* findByName(olds, name);
          if (!column) return undefined;
          const attrs = toAttributes(column);
          // A generated name carries this instance's suffix, so it is ours.
          return olds.name === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "customColumnId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* braintrustName(id, news.name);

          // Observe — by id once we have one (it survives renames), else by
          // name. A changed table replaces the column, so `news` names the
          // table the cached id lives in.
          const columns = yield* listTable(news);
          let column =
            (output ? columns.find((c) => c.id === output.customColumnId) : undefined) ??
            columns.find((c) => c.name === name);

          // Ensure — POST returns the existing column of the same name in the
          // table unchanged, so a concurrent create converges on one column.
          if (!column) {
            yield* session.note(`Creating custom column ${name}...`);
            column = yield* braintrust.createColumn({
              object_type: news.objectType,
              object_id: news.objectId,
              subtype: news.subtype,
              variant: news.variant,
              name,
              expr: news.expr,
            });
          }

          // Sync — PATCH only the fields that differ from what is deployed.
          const update: Omit<braintrust.UpdateColumnRequest, "column_id"> = {};
          if (column.name !== name) update.name = name;
          if (column.expr !== news.expr) update.expr = news.expr;
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating custom column ${name}...`);
            column = yield* braintrust.updateColumn({ column_id: column.id, ...update });
          }

          return toAttributes(column);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteColumn({ column_id: output.customColumnId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        // Columns can only be listed one table at a time, by a scope that
        // includes the subtype and variant, so there is no way to enumerate
        // the ones Alchemy made. Deleting their project hides them.
        list: Effect.fn(function* () {
          return [];
        }),
      };
    }),
  );
