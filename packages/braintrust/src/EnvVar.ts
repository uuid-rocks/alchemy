import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

/** The kind of object an environment variable is scoped to. */
export type EnvVarObjectType = "organization" | "project" | "function" | "mcp_server";

export interface EnvVarProps {
  /**
   * The kind of object the variable is scoped to. Changing it replaces the
   * variable.
   */
  objectType: EnvVarObjectType;
  /**
   * Id of the object the variable is scoped to: the organization id
   * (`project.orgId`), `project.projectId`, or a function id. Changing it
   * replaces the variable.
   */
  objectId: string;
  /**
   * Variable name, unique within its object, e.g. `OPENAI_API_KEY`.
   * Renaming updates the variable in place.
   */
  name: string;
  /**
   * The value. Braintrust encrypts it at rest and never returns it, so
   * Alchemy rewrites it when it changes here or when it was rotated outside
   * Alchemy.
   */
  value: Redacted.Redacted<string>;
  /**
   * User-controlled metadata. Replaced as a whole on every change; removing
   * it clears the metadata.
   */
  metadata?: Record<string, unknown>;
  /**
   * Optional classification of the secret, for example the AI provider name.
   * Removing it clears the classification.
   */
  secretType?: string;
}

export interface EnvVarAttributes {
  /** Unique identifier of the variable. */
  envVarId: string;
  /** The kind of object the variable is scoped to. */
  objectType: EnvVarObjectType;
  /** Id of the object the variable is scoped to. */
  objectId: string;
  /** Variable name. */
  name: string;
  /** User-controlled metadata. */
  metadata: Record<string, unknown> | undefined;
  /** Classification of the secret. */
  secretType: string | undefined;
  /** Braintrust's category for the secret, e.g. `env_var` or `ai_provider`. */
  secretCategory: string | undefined;
  /** Braintrust's masked preview of the stored value. */
  previewSecret: Redacted.Redacted<string> | undefined;
  /** When the value was last written (ISO 8601). */
  secretUpdatedAt: string | undefined;
  /** When the variable was created (ISO 8601). */
  created: string | undefined;
}

export type EnvVar = Resource<
  "Braintrust.EnvVar",
  EnvVarProps,
  EnvVarAttributes,
  never,
  Providers,
  EnvVarLookup
>;

/**
 * Props for {@link EnvVar.lookup}: find a variable this stack doesn't
 * manage by its scope and name. The value is never returned.
 */
export interface EnvVarLookup {
  /** The kind of object the variable is scoped to. */
  objectType: EnvVarObjectType;
  /** Id of the object the variable is scoped to. */
  objectId: string;
  /** Variable name. */
  name: string;
}

/**
 * A Braintrust environment variable: an encrypted secret that functions and
 * scorers running in Braintrust read at runtime, scoped to the whole
 * organization, one project, or one function. See
 * [Function environment variables](https://www.braintrust.dev/docs/deploy/functions#environment-variables).
 *
 * The value is a `Redacted` string: Alchemy never logs it, and state keeps
 * it as a `Redacted` value like every other secret prop. Braintrust never
 * returns it, so a value rotated in the Braintrust UI is detected by its
 * update time and rewritten on the next deploy.
 *
 * Variables carry no tags Alchemy can use for ownership, so a variable found
 * under the same scope and name with no prior state is refused unless
 * adopted. Adopting one rewrites its value.
 *
 * :::caution
 * Changing `objectType` or `objectId` replaces the variable.
 * :::
 *
 * :::note
 * Deleting a project doesn't delete its variables. Alchemy deletes each
 * variable by its id, which works whether or not the project still exists.
 * :::
 *
 * ### Creating an environment variable
 * **Example:** Project-scoped secret
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * const project = yield* Braintrust.Project("Support", {});
 * const apiKey = yield* Braintrust.EnvVar("SearchApiKey", {
 *   objectType: "project",
 *   objectId: project.projectId,
 *   name: "SEARCH_API_KEY",
 *   value: Redacted.make(process.env.SEARCH_API_KEY!),
 * });
 * ```
 *
 * **Example:** Organization-wide secret from Effect `Config`
 * ```typescript
 * import * as Config from "effect/Config";
 *
 * const project = yield* Braintrust.Project("Support", {});
 * const token = yield* Braintrust.EnvVar("SlackToken", {
 *   objectType: "organization",
 *   objectId: project.orgId,
 *   name: "SLACK_BOT_TOKEN",
 *   value: yield* Config.redacted("SLACK_BOT_TOKEN"),
 * });
 * ```
 *
 * ### Looking up an existing variable
 * **Example:** Reference a variable made in the Braintrust UI
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const variable = Braintrust.EnvVar.lookup({
 *   objectType: "project",
 *   objectId: project.projectId,
 *   name: "SEARCH_API_KEY",
 * });
 * ```
 *
 * @resource
 * @product EnvVar
 */
export const EnvVar = Resource<EnvVar>("Braintrust.EnvVar");

const toAttributes = (envVar: braintrust.EnvVar): EnvVarAttributes => ({
  envVarId: envVar.id,
  objectType: envVar.object_type,
  objectId: envVar.object_id,
  name: envVar.name,
  metadata: envVar.metadata ?? undefined,
  secretType: envVar.secret_type ?? undefined,
  secretCategory: envVar.secret_category,
  previewSecret:
    envVar.preview_secret == null
      ? undefined
      : Redacted.isRedacted(envVar.preview_secret)
        ? envVar.preview_secret
        : Redacted.make(envVar.preview_secret),
  secretUpdatedAt: envVar.secret_updated_at ?? undefined,
  created: envVar.created ?? undefined,
});

const getById = (envVarId: string) =>
  braintrust
    .getEnvVar({ env_var_id: envVarId })
    .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined));

const findByName = (objectType: EnvVarObjectType, objectId: string, name: string) =>
  braintrust
    .listEnvVars({ object_type: objectType, object_id: objectId, env_var_name: name })
    .pipe(
      Effect.map(({ objects }) =>
        objects.find(
          (envVar) =>
            envVar.object_type === objectType &&
            envVar.object_id === objectId &&
            envVar.name === name,
        ),
      ),
    );

export const EnvVarProvider = () =>
  Provider.effect(
    EnvVar,
    Effect.gen(function* () {
      return {
        stables: ["envVarId", "objectType", "objectId"],
        // Project deletion leaves its variables behind, and they are only
        // listed through a live project, so variables go first.
        nuke: { dependsOn: ["Braintrust.Project"] },
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.objectType !== olds.objectType || news.objectId !== olds.objectId) {
            return { action: "replace" } as const;
          }
        }),
        lookup: Effect.fn(function* ({ objectType, objectId, name }) {
          const envVar = yield* findByName(objectType, objectId, name);
          return envVar ? toAttributes(envVar) : undefined;
        }),
        read: Effect.fn(function* ({ olds, output, previous }) {
          if (output) {
            const envVar = yield* getById(output.envVarId);
            return envVar ? toAttributes(envVar) : undefined;
          }
          const envVar = yield* findByName(olds.objectType, olds.objectId, olds.name);
          // Names are always user-chosen, so a variable found without state
          // is someone else's unless a replacement is replacing it.
          return envVar
            ? unownedUnlessPrevious(toAttributes(envVar), previous, "envVarId")
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, olds, output, session }) {
          const inScope = (envVar: braintrust.EnvVar | undefined) =>
            envVar?.object_type === news.objectType && envVar.object_id === news.objectId
              ? envVar
              : undefined;

          // Observe — by id once we have one (it survives renames), else by name.
          let envVar =
            inScope(output ? yield* getById(output.envVarId) : undefined) ??
            (yield* findByName(news.objectType, news.objectId, news.name));

          // Ensure — POST returns an existing variable of the same name
          // unchanged (its value too), so a concurrent create converges on
          // one variable.
          let created = false;
          if (!envVar) {
            yield* session.note(`Creating environment variable ${news.name}...`);
            envVar = yield* braintrust.createEnvVar({
              object_type: news.objectType,
              object_id: news.objectId,
              name: news.name,
              value: news.value,
              metadata: news.metadata,
              secret_type: news.secretType,
            });
            created = true;
          }

          // Sync — the value is write-only. Rewrite it unless we just created
          // it, or it is the value we last wrote and nobody has written one
          // since (the update time we recorded still matches).
          const update: Omit<braintrust.UpdateEnvVarRequest, "env_var_id" | "name"> = {};
          const valueKnown =
            olds !== undefined &&
            Redacted.value(olds.value) === Redacted.value(news.value) &&
            output?.secretUpdatedAt === (envVar.secret_updated_at ?? undefined);
          if (!created && !valueKnown) update.value = news.value;
          // `null` clears metadata and the classification; metadata is
          // replaced as a whole.
          if (!deepEqual(envVar.metadata ?? undefined, news.metadata)) {
            update.metadata = news.metadata ?? null;
          }
          if ((envVar.secret_type ?? undefined) !== news.secretType) {
            update.secret_type = news.secretType ?? null;
          }
          if (envVar.name !== news.name || Object.keys(update).length > 0) {
            yield* session.note(`Updating environment variable ${news.name}...`);
            // PATCH requires the name on every call.
            envVar = yield* braintrust.updateEnvVar({
              env_var_id: envVar.id,
              name: news.name,
              ...update,
            });
          }

          return toAttributes(envVar);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteEnvVar({ env_var_id: output.envVarId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          // Names are user-chosen, so only variables inside Alchemy-owned
          // projects can be told apart from hand-made ones.
          const projects = yield* Stream.runCollect(braintrust.listProjects.items({}));
          const owned = projects.filter(
            (project) => !project.deleted_at && isGeneratedName(project.name),
          );
          const lists = yield* Effect.forEach(
            owned,
            (project) => braintrust.listEnvVars({ object_type: "project", object_id: project.id }),
            { concurrency: 4 },
          );
          return lists.flatMap(({ objects }) => objects.map(toAttributes));
        }),
      };
    }),
  );
