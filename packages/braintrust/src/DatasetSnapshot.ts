import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { braintrustName, isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface DatasetSnapshotProps {
  /**
   * Id of the dataset the snapshot belongs to, e.g. `dataset.datasetId`.
   * Changing it replaces the snapshot.
   */
  datasetId: string;
  /**
   * Transaction id of the dataset version to pin, as returned in the
   * `_xact_id` of the dataset's records. Changing it replaces the
   * snapshot.
   */
  xactId: string;
  /**
   * Snapshot name, unique within the dataset. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Renaming updates the
   * snapshot in place.
   */
  name?: string;
  /** Textual description of the snapshot. Removing it clears the description. */
  description?: string;
}

export interface DatasetSnapshotAttributes {
  /** Unique identifier of the dataset snapshot. */
  datasetSnapshotId: string;
  /** Id of the dataset the snapshot belongs to. */
  datasetId: string;
  /** Transaction id of the pinned dataset version. */
  xactId: string;
  /** Snapshot name. */
  name: string;
  /** Textual description of the snapshot. */
  description: string | undefined;
  /** When the snapshot was created (ISO 8601). */
  created: string | undefined;
}

export type DatasetSnapshot = Resource<
  "Braintrust.DatasetSnapshot",
  DatasetSnapshotProps,
  DatasetSnapshotAttributes,
  never,
  Providers,
  DatasetSnapshotLookup
>;

/**
 * Props for {@link DatasetSnapshot.lookup}: find a snapshot this stack
 * doesn't manage by its dataset and name.
 */
export interface DatasetSnapshotLookup {
  /** Id of the dataset the snapshot belongs to. */
  datasetId: string;
  /** Snapshot name. */
  name: string;
}

/**
 * A Braintrust dataset snapshot: a named, pinned version of a dataset that
 * experiments can run against while the dataset keeps changing. See
 * [Datasets](https://www.braintrust.dev/docs/guides/datasets).
 *
 * Snapshots carry no labels Alchemy can use for ownership, so a snapshot
 * found under an explicit `name` with no prior state is refused unless
 * adopted.
 *
 * :::caution
 * Changing `datasetId` or `xactId` replaces the snapshot. A new `xactId`
 * deletes the old snapshot before creating the new one, because both would
 * hold the same name in the same dataset.
 * :::
 *
 * ### Creating a Dataset Snapshot
 * **Example:** Pin a dataset version
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const dataset = yield* Braintrust.Dataset("Tickets", {
 *   projectId: project.projectId,
 * });
 * const snapshot = yield* Braintrust.DatasetSnapshot("Release", {
 *   datasetId: dataset.datasetId,
 *   name: "v1",
 *   xactId: "1000196022104685824",
 *   description: "Tickets reviewed for the v1 release",
 * });
 * ```
 *
 * ### Looking up an existing snapshot
 * **Example:** Reference a snapshot made in the Braintrust UI
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const dataset = Braintrust.Dataset.lookup({
 *   projectId: project.projectId,
 *   name: "Golden tickets",
 * });
 * const snapshot = Braintrust.DatasetSnapshot.lookup({
 *   datasetId: dataset.datasetId,
 *   name: "v1",
 * });
 * ```
 *
 * @resource
 * @product Dataset Snapshot
 */
export const DatasetSnapshot = Resource<DatasetSnapshot>("Braintrust.DatasetSnapshot");

const toAttributes = (snapshot: braintrust.DatasetSnapshot): DatasetSnapshotAttributes => ({
  datasetSnapshotId: snapshot.id,
  datasetId: snapshot.dataset_id,
  xactId: snapshot.xact_id,
  name: snapshot.name,
  description: snapshot.description ?? undefined,
  created: snapshot.created ?? undefined,
});

const getById = (datasetSnapshotId: string) =>
  braintrust
    .getDatasetSnapshot({ dataset_snapshot_id: datasetSnapshotId })
    .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined));

// The list takes no dataset filter; filter by dataset client-side.
const findByName = (datasetId: string, name: string) =>
  braintrust.listDatasetSnapshots.items({ dataset_snapshot_name: name }).pipe(
    Stream.filter((snapshot) => snapshot.dataset_id === datasetId && snapshot.name === name),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const DatasetSnapshotProvider = () =>
  Provider.effect(
    DatasetSnapshot,
    Effect.gen(function* () {
      return {
        stables: ["datasetSnapshotId", "datasetId", "xactId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.datasetId !== olds.datasetId) return { action: "replace" } as const;
          // Creating first would collide on the name in the same dataset:
          // Braintrust renames the new snapshot, and renaming it back fails.
          if (news.xactId !== olds.xactId) {
            return { action: "replace", deleteFirst: true } as const;
          }
        }),
        lookup: Effect.fn(function* ({ datasetId, name }) {
          const snapshot = yield* findByName(datasetId, name);
          return snapshot ? toAttributes(snapshot) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const snapshot = yield* getById(output.datasetSnapshotId);
            return snapshot ? toAttributes(snapshot) : undefined;
          }
          const name = yield* braintrustName(id, olds.name);
          const snapshot = yield* findByName(olds.datasetId, name);
          if (!snapshot) return undefined;
          const attrs = toAttributes(snapshot);
          // A generated name carries this instance's suffix, so it is ours.
          return olds.name === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "datasetSnapshotId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* braintrustName(id, news.name);

          // Observe — by id once we have one (it survives renames), else by
          // name. The version is immutable, so only a snapshot of the
          // desired version counts.
          const cached = output ? yield* getById(output.datasetSnapshotId) : undefined;
          let snapshot =
            (cached?.dataset_id === news.datasetId ? cached : undefined) ??
            (yield* findByName(news.datasetId, name));
          if (snapshot && snapshot.xact_id !== news.xactId) snapshot = undefined;

          // Ensure — POST returns the existing snapshot of the same name and
          // version unchanged, so a concurrent create converges on one.
          if (!snapshot) {
            yield* session.note(`Creating dataset snapshot ${name}...`);
            snapshot = yield* braintrust.createDatasetSnapshot({
              dataset_id: news.datasetId,
              name,
              xact_id: news.xactId,
              description: news.description,
            });
          }

          // Sync — PATCH only the fields that differ from what is deployed.
          // `null` clears the description.
          const update: Omit<braintrust.UpdateDatasetSnapshotRequest, "dataset_snapshot_id"> = {};
          if (snapshot.name !== name) update.name = name;
          if ((snapshot.description ?? undefined) !== news.description) {
            update.description = news.description ?? null;
          }
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating dataset snapshot ${name}...`);
            snapshot = yield* braintrust.updateDatasetSnapshot({
              dataset_snapshot_id: snapshot.id,
              ...update,
            });
          }

          return toAttributes(snapshot);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteDatasetSnapshot({ dataset_snapshot_id: output.datasetSnapshotId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const snapshots = yield* Stream.runCollect(braintrust.listDatasetSnapshots.items({}));
          return snapshots.filter((snapshot) => isGeneratedName(snapshot.name)).map(toAttributes);
        }),
      };
    }),
  );
