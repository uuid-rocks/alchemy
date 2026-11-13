import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { braintrustName, isGeneratedName, unlessDeleted } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface EnvironmentProps {
  /**
   * URL-friendly identifier, unique within the organization. If omitted, a
   * unique slug is generated from the stack, stage and logical ID. Changing
   * it updates the environment in place.
   */
  slug?: string;
  /**
   * Display name of the environment.
   * @default the slug
   */
  name?: string;
  /** Textual description of the environment. Removing it clears the description. */
  description?: string;
}

export interface EnvironmentAttributes {
  /** Unique identifier of the environment. */
  environmentId: string;
  /** Id of the organization the environment belongs to. */
  orgId: string;
  /** URL-friendly identifier, unique within the organization. */
  slug: string;
  /** Display name of the environment. */
  name: string;
  /** Textual description of the environment. */
  description: string | undefined;
  /** When the environment was created (ISO 8601). */
  created: string | undefined;
}

export type Environment = Resource<
  "Braintrust.Environment",
  EnvironmentProps,
  EnvironmentAttributes,
  never,
  Providers,
  EnvironmentLookup
>;

/**
 * Props for {@link Environment.lookup}: find an environment this stack
 * doesn't manage by its slug.
 */
export interface EnvironmentLookup {
  /** URL-friendly identifier of the environment. */
  slug: string;
}

/**
 * A Braintrust environment: an organization-wide label such as `staging` or
 * `production` that prompt and function versions are assigned to, so code
 * can load "the production version" of a prompt. See
 * [Environments](https://www.braintrust.dev/docs/deploy/environments).
 *
 * Environments carry no tags Alchemy can use for ownership, so an
 * environment found under an explicit `slug` with no prior state is refused
 * unless adopted. Every property updates in place.
 *
 * ### Creating an Environment
 * **Example:** Environment with a generated slug
 * ```typescript
 * const staging = yield* Braintrust.Environment("Staging", {});
 * ```
 *
 * **Example:** Environment with an explicit slug and name
 * ```typescript
 * const production = yield* Braintrust.Environment("Production", {
 *   slug: "production",
 *   name: "Production",
 *   description: "Versions served to customers",
 * });
 * ```
 *
 * ### Looking up an existing environment
 * **Example:** Reference an environment made in the Braintrust UI
 * ```typescript
 * const production = Braintrust.Environment.lookup({ slug: "production" });
 * ```
 *
 * @resource
 * @product Environment
 */
export const Environment = Resource<Environment>("Braintrust.Environment");

const toAttributes = (environment: braintrust.Environment): EnvironmentAttributes => ({
  environmentId: environment.id,
  orgId: environment.org_id,
  slug: environment.slug,
  name: environment.name,
  description: environment.description ?? undefined,
  created: environment.created ?? undefined,
});

const getById = (environmentId: string) =>
  braintrust.getEnvironment({ environment_id: environmentId }).pipe(
    Effect.map(unlessDeleted),
    Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined),
  );

// The list has no slug filter and no pagination: it returns every environment.
const listLive = braintrust
  .listEnvironments({})
  .pipe(Effect.map(({ objects }) => objects.filter((environment) => !environment.deleted_at)));

const findBySlug = (slug: string) =>
  listLive.pipe(Effect.map((environments) => environments.find((e) => e.slug === slug)));

export const EnvironmentProvider = () =>
  Provider.effect(
    Environment,
    Effect.gen(function* () {
      return {
        stables: ["environmentId", "orgId"],
        lookup: Effect.fn(function* ({ slug }) {
          const environment = yield* findBySlug(slug);
          return environment ? toAttributes(environment) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const environment = yield* getById(output.environmentId);
            return environment ? toAttributes(environment) : undefined;
          }
          const slug = yield* braintrustName(id, olds?.slug);
          const environment = yield* findBySlug(slug);
          if (!environment) return undefined;
          const attrs = toAttributes(environment);
          // A generated slug carries this instance's suffix, so it is ours.
          return olds?.slug === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "environmentId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const slug = yield* braintrustName(id, news.slug);
          const name = news.name ?? slug;

          // Observe — by id once we have one (it survives slug changes), else by slug.
          let environment =
            (output ? yield* getById(output.environmentId) : undefined) ??
            (yield* findBySlug(slug));

          // Ensure — unlike most Braintrust objects, a second create with the
          // same slug fails rather than returning the existing environment.
          if (!environment) {
            yield* session.note(`Creating environment ${slug}...`);
            environment = yield* braintrust.createEnvironment({
              slug,
              name,
              description: news.description,
            });
          }

          // Sync — PATCH only the fields that differ; `null` clears the description.
          const update: Omit<braintrust.UpdateEnvironmentRequest, "environment_id"> = {};
          if (environment.slug !== slug) update.slug = slug;
          if (environment.name !== name) update.name = name;
          if ((environment.description ?? undefined) !== news.description) {
            update.description = news.description ?? null;
          }
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating environment ${slug}...`);
            environment = yield* braintrust.updateEnvironment({
              environment_id: environment.id,
              ...update,
            });
          }

          return toAttributes(environment);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteEnvironment({ environment_id: output.environmentId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const environments = yield* listLive;
          return environments.filter((e) => isGeneratedName(e.slug)).map(toAttributes);
        }),
      };
    }),
  );
