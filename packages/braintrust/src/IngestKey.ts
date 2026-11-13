import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { braintrustName, isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface IngestKeyProps {
  /**
   * Id of the project the key writes logs to, e.g. `project.projectId`.
   * Changing it replaces the key.
   */
  projectId: string;
  /**
   * Key name. Names need not be unique. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it replaces the
   * key.
   */
  name?: string;
}

export interface IngestKeyAttributes {
  /** Unique identifier of the key. */
  ingestKeyId: string;
  /** Id of the project the key writes logs to. */
  projectId: string;
  /** Id of the organization the key belongs to. */
  orgId: string;
  /** Key name. */
  name: string;
  /** The key's public prefix, e.g. `bt-ik-3bag`, as the Braintrust UI shows it. */
  previewName: string;
  /**
   * The configuration URL to send logs to, with the key embedded in it.
   * `undefined` when the organization's API URL can't be used with ingest
   * keys.
   */
  url: Redacted.Redacted<string> | undefined;
  /** When the key was created (ISO 8601). */
  created: string | undefined;
}

export type IngestKey = Resource<
  "Braintrust.IngestKey",
  IngestKeyProps,
  IngestKeyAttributes,
  never,
  Providers,
  IngestKeyLookup
>;

/**
 * Props for {@link IngestKey.lookup}: find a key this stack doesn't manage
 * by its id, since key names are not unique.
 */
export interface IngestKeyLookup {
  /** Id of the project the key writes logs to. */
  projectId: string;
  /** Unique identifier of the key. */
  ingestKeyId: string;
}

/**
 * A Braintrust ingest key: a publishable credential that can only write
 * logs to one project, for clients you don't want to hold an API key. It
 * never expires and stays valid until it is revoked.
 *
 * The key is returned inside the configuration `url`, which Alchemy exposes
 * as a `Redacted` attribute and never logs. State keeps it as a `Redacted`
 * value like every other secret.
 *
 * Key names are not unique, so Alchemy tracks the key by its id. A key with
 * an explicit `name` found with no prior state is refused unless adopted.
 * Deleting the resource revokes the key; Braintrust may keep accepting it
 * until its authorization caches expire.
 *
 * :::caution
 * Ingest keys can't be updated. Changing `projectId` or `name` revokes the
 * key and issues a new one with a different URL.
 * :::
 *
 * ### Creating an ingest key
 * **Example:** Key for a project's logs
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const key = yield* Braintrust.IngestKey("BrowserLogs", {
 *   projectId: project.projectId,
 * });
 * // key.url is Redacted<string>: pass it to the client that sends logs.
 * ```
 *
 * ### Looking up an existing key
 * **Example:** Reference a key made in the Braintrust UI
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const key = Braintrust.IngestKey.lookup({
 *   projectId: project.projectId,
 *   ingestKeyId: "3f6c…",
 * });
 * ```
 *
 * @resource
 * @product IngestKey
 */
export const IngestKey = Resource<IngestKey>("Braintrust.IngestKey");

const toAttributes = (
  key: braintrust.CreateIngestKeyResponse | braintrust.ListIngestKeysResponseObjectsItem,
): IngestKeyAttributes => ({
  ingestKeyId: key.id,
  projectId: key.project_id,
  orgId: key.org_id,
  name: key.name,
  previewName: key.preview_name,
  url:
    key.url == null ? undefined : Redacted.isRedacted(key.url) ? key.url : Redacted.make(key.url),
  created: key.created ?? undefined,
});

// There is no get by id: keys are read from the project's list. A key of a
// deleted project is no longer listed, which is gone for us too.
const find = (
  projectId: string,
  predicate: (key: braintrust.ListIngestKeysResponseObjectsItem) => boolean,
) =>
  braintrust.listIngestKeys
    .items({ project_id: projectId })
    .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrUndefined));

const findById = (projectId: string, ingestKeyId: string) =>
  find(projectId, (key) => key.id === ingestKeyId);

const findByName = (projectId: string, name: string) => find(projectId, (key) => key.name === name);

export const IngestKeyProvider = () =>
  Provider.effect(
    IngestKey,
    Effect.gen(function* () {
      return {
        stables: ["ingestKeyId", "projectId", "orgId", "name", "previewName", "url"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.projectId !== olds.projectId || news.name !== olds.name) {
            return { action: "replace" } as const;
          }
        }),
        lookup: Effect.fn(function* ({ projectId, ingestKeyId }) {
          const key = yield* findById(projectId, ingestKeyId);
          return key ? toAttributes(key) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const key = yield* findById(output.projectId, output.ingestKeyId);
            return key ? toAttributes(key) : undefined;
          }
          const name = yield* braintrustName(id, olds.name);
          const key = yield* findByName(olds.projectId, name);
          if (!key) return undefined;
          const attrs = toAttributes(key);
          // A generated name carries this instance's suffix, so it is ours.
          return olds.name === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "ingestKeyId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* braintrustName(id, news.name);

          // Observe — by id once we have one; nothing about a key is
          // mutable, so an observed key is already converged.
          const existing =
            output && output.projectId === news.projectId
              ? yield* findById(news.projectId, output.ingestKeyId)
              : undefined;
          if (existing) return toAttributes(existing);

          // Ensure — every POST issues a new key, even under a name in use.
          yield* session.note(`Creating ingest key ${name}...`);
          const created = yield* braintrust.createIngestKey({ project_id: news.projectId, name });
          return toAttributes(created);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteIngestKey({ id: output.ingestKeyId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          // Keys are listed per project; only Alchemy-owned projects are walked.
          const projects = yield* Stream.runCollect(braintrust.listProjects.items({}));
          const owned = projects.filter(
            (project) => !project.deleted_at && isGeneratedName(project.name),
          );
          const keys = yield* Effect.forEach(
            owned,
            (project) =>
              Stream.runCollect(braintrust.listIngestKeys.items({ project_id: project.id })),
            { concurrency: 4 },
          );
          return keys
            .flat()
            .filter((key) => isGeneratedName(key.name))
            .map(toAttributes);
        }),
      };
    }),
  );
