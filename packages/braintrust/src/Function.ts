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

type CodeData = Extract<braintrust.FunctionData, { type: "code" }>["data"];

/** Source code Braintrust runs in its own sandbox, stored on the function. */
export interface InlineCodeFunctionData {
  type: "code";
  data: Omit<Extract<CodeData, { type: "inline" }>, "code_hash">;
}

/** A built-in Braintrust function (an autoevals scorer such as `Factuality`), by name. */
export type GlobalFunctionData = Extract<braintrust.FunctionData, { type: "global" }>;

/** What a {@link Function} runs. */
export type FunctionData = InlineCodeFunctionData | GlobalFunctionData;

export interface FunctionProps {
  /**
   * Id of the project the function belongs to, e.g. `project.projectId`.
   * Changing it replaces the function, and every version of the old one is
   * deleted with it.
   */
  projectId: string;
  /**
   * Slug the function is invoked by, unique within the project. If
   * omitted, a unique slug is generated from the stack, stage and logical
   * ID. Braintrust can't change a function's slug, so changing it replaces
   * the function.
   */
  slug?: string;
  /**
   * Display name of the function.
   * @default the slug
   */
  name?: string;
  /** Textual description of the function. Removing it clears the description. */
  description?: string;
  /**
   * What the function runs: inline source code (`type: "code"` with
   * `data.type: "inline"`, its runtime and the code), or a built-in
   * function (`type: "global"` and its name). Written as a whole on every
   * change.
   */
  functionData: FunctionData;
  /**
   * What the function is used as: `scorer`, `task`, `tool`,
   * `preprocessor`, `classifier`, and so on.
   */
  functionType?: braintrust.FunctionTypeEnumNullish;
  /**
   * JSON schemas for the function's `parameters` and `returns` value. Tools
   * need `parameters` so a model knows how to call them. Removing it clears
   * the schema.
   */
  functionSchema?: braintrust.CreateFunctionRequestFunctionSchema;
  /** Tags for the function. Removing them clears the tags. */
  tags?: string[];
}

export interface FunctionAttributes {
  /** Unique identifier of the function; the same across versions. */
  functionId: string;
  /** Id of the project the function belongs to. */
  projectId: string;
  /** Slug the function is invoked by. */
  slug: string;
  /** Display name of the function. */
  name: string;
  /** Textual description of the function. */
  description: string | undefined;
  /** What the function runs, as Braintrust stores it. */
  functionData: braintrust.FunctionData;
  /** What the function is used as. */
  functionType: braintrust.FunctionTypeEnumNullish | undefined;
  /** JSON schemas for the function's parameters and return value. */
  functionSchema: braintrust.CreateFunctionRequestFunctionSchema | undefined;
  /** Tags for the function. */
  tags: string[];
  /**
   * Transaction id of the current version (`_xact_id`). It changes on
   * every write; pass it as `version` to invoke this exact version.
   */
  version: string;
  /** When the function was created (ISO 8601). */
  created: string | undefined;
}

export type Function = Resource<
  "Braintrust.Function",
  FunctionProps,
  FunctionAttributes,
  never,
  Providers,
  FunctionLookup
>;

/**
 * Props for {@link Function.lookup}: find a function this stack doesn't
 * manage by its project and slug.
 */
export interface FunctionLookup {
  /** Id of the project the function belongs to. */
  projectId: string;
  /** Slug of the function. */
  slug: string;
}

/**
 * A Braintrust function: versioned code that runs as a scorer, task or
 * tool, invoked by slug from evals, from prompts as a tool, or through the
 * API. See [Functions](https://www.braintrust.dev/docs/guides/functions).
 *
 * Alchemy manages inline code functions, whose source is stored on the
 * function, and references to built-in (`global`) functions. A function
 * backed by a prompt is a {@link Prompt} with a `functionType`. Bundled
 * code, which `braintrust push` uploads through an endpoint Braintrust's
 * API description doesn't publish (`/function/code`), and the UI-built
 * variants (graphs, remote evals, facets, topic maps, parameters,
 * simulations) are not managed here; reference them with
 * {@link Function.lookup}.
 *
 * Every write to a function appends a version, so Alchemy writes only when
 * the deployed function differs from the props, and then writes the whole
 * function once. The `version` attribute moves with each write.
 *
 * Functions carry no labels Alchemy can use for ownership, so a function
 * found under an explicit `slug` with no prior state is refused unless
 * adopted.
 *
 * :::caution
 * Changing `projectId` or `slug` replaces the function. Every version of
 * the old function is deleted with it.
 * :::
 *
 * :::caution
 * Braintrust stores function versions as logs, so creating or changing a
 * function fails with `PaymentRequired` while the organization is out of
 * log credits.
 * :::
 *
 * ### Creating a Function
 * **Example:** Inline TypeScript scorer
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const exact = yield* Braintrust.Function("ExactAnswer", {
 *   projectId: project.projectId,
 *   slug: "exact-answer",
 *   functionType: "scorer",
 *   functionData: {
 *     type: "code",
 *     data: {
 *       type: "inline",
 *       runtime_context: { runtime: "node", version: "20" },
 *       code: "function handler({ output, expected }) { return output === expected ? 1 : 0; }",
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Inline Python task
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const classify = yield* Braintrust.Function("Classify", {
 *   projectId: project.projectId,
 *   functionType: "task",
 *   description: "Routes a ticket to a queue",
 *   functionData: {
 *     type: "code",
 *     data: {
 *       type: "inline",
 *       runtime_context: { runtime: "python", version: "3.12" },
 *       code: "def handler(input):\n    return 'billing' if 'invoice' in input else 'general'",
 *     },
 *   },
 * });
 * ```
 *
 * ### Using a built-in scorer
 * **Example:** Wrap the Factuality autoeval
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const factuality = yield* Braintrust.Function("Factuality", {
 *   projectId: project.projectId,
 *   functionType: "scorer",
 *   functionData: { type: "global", name: "Factuality" },
 * });
 * ```
 *
 * ### Exposing a tool to prompts
 * **Example:** Tool with a parameter schema
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const lookupOrder = yield* Braintrust.Function("LookupOrder", {
 *   projectId: project.projectId,
 *   slug: "lookup-order",
 *   functionType: "tool",
 *   functionSchema: {
 *     parameters: {
 *       type: "object",
 *       properties: { orderId: { type: "string" } },
 *       required: ["orderId"],
 *     },
 *   },
 *   functionData: {
 *     type: "code",
 *     data: {
 *       type: "inline",
 *       runtime_context: { runtime: "node", version: "20" },
 *       code: "async function handler({ orderId }) { return { orderId, status: 'shipped' }; }",
 *     },
 *   },
 * });
 * const agent = yield* Braintrust.Prompt("Agent", {
 *   projectId: project.projectId,
 *   promptData: {
 *     prompt: {
 *       type: "chat",
 *       messages: [{ role: "user", content: "Where is order {{orderId}}?" }],
 *     },
 *     options: { model: "gpt-4o-mini" },
 *     tool_functions: [{ type: "function", id: lookupOrder.functionId }],
 *   },
 * });
 * ```
 *
 * ### Looking up an existing function
 * **Example:** Reference a function pushed with `braintrust push`
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const scorer = Braintrust.Function.lookup({
 *   projectId: project.projectId,
 *   slug: "exact-answer",
 * });
 * ```
 *
 * @resource
 * @product Function
 */
export const Function = Resource<Function>("Braintrust.Function");

const managedTypes: ReadonlyArray<string> = ["code", "global"];

// Braintrust adds `code_hash` to inline code on save; it isn't part of what
// the props describe.
const withoutCodeHash = (data: braintrust.FunctionData): braintrust.FunctionData => {
  if (data.type !== "code" || data.data.type !== "inline") return data;
  const { code_hash: _, ...code } = data.data;
  return { ...data, data: code };
};

const toAttributes = (fn: braintrust.Function): FunctionAttributes => ({
  functionId: fn.id,
  projectId: fn.project_id,
  slug: fn.slug,
  name: fn.name,
  description: fn.description || undefined,
  functionData: fn.function_data,
  functionType: fn.function_type ?? undefined,
  functionSchema: fn.function_schema ?? undefined,
  tags: [...(fn.tags ?? [])],
  version: fn._xact_id,
  created: fn.created ?? undefined,
});

const getById = (functionId: string) =>
  braintrust
    .getFunction({ function_id: functionId })
    .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined));

const findBySlug = (projectId: string, slug: string) =>
  braintrust.listFunctions.items({ project_id: projectId, slug }).pipe(
    Stream.filter((fn) => fn.project_id === projectId && fn.slug === slug),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const FunctionProvider = () =>
  Provider.effect(
    Function,
    Effect.gen(function* () {
      return {
        stables: ["functionId", "projectId", "slug"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.projectId !== olds.projectId || news.slug !== olds.slug) {
            return { action: "replace" } as const;
          }
        }),
        lookup: Effect.fn(function* ({ projectId, slug }) {
          const fn = yield* findBySlug(projectId, slug);
          return fn ? toAttributes(fn) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const fn = yield* getById(output.functionId);
            return fn ? toAttributes(fn) : undefined;
          }
          const slug = yield* braintrustName(id, olds.slug);
          const fn = yield* findBySlug(olds.projectId, slug);
          if (!fn) return undefined;
          const attrs = toAttributes(fn);
          // A generated slug carries this instance's suffix, so it is ours.
          return olds.slug === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "functionId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const slug = yield* braintrustName(id, news.slug);
          // The whole function, with explicit empty values so a removed
          // field is cleared from the version this writes.
          const body = {
            project_id: news.projectId,
            slug,
            name: news.name ?? slug,
            description: news.description ?? null,
            function_data: news.functionData,
            function_type: news.functionType ?? null,
            function_schema: news.functionSchema ?? null,
            tags: news.tags ?? [],
          };

          // Observe — by id once we have one, else by slug.
          const cached = output ? yield* getById(output.functionId) : undefined;
          let fn =
            (cached?.project_id === news.projectId ? cached : undefined) ??
            (yield* findBySlug(news.projectId, slug));

          // Ensure — POST on a taken slug appends a version to that
          // function instead of failing, so a concurrent create converges
          // on one.
          if (!fn) {
            yield* session.note(`Creating function ${slug}...`);
            fn = yield* braintrust.createFunction(body);
          }

          // Sync — every write appends a version, so compare first. PATCH
          // deep-merges `function_data` and can't remove a field, so a
          // change PUTs the whole function: one version on this slug.
          const observed = toAttributes(fn);
          const unchanged =
            observed.name === body.name &&
            observed.description === news.description &&
            deepEqual(observed.tags, body.tags) &&
            deepEqual(withoutCodeHash(observed.functionData), news.functionData, {
              stripNullish: true,
            }) &&
            observed.functionType === news.functionType &&
            deepEqual(observed.functionSchema, news.functionSchema, { stripNullish: true });
          if (!unchanged) {
            yield* session.note(`Writing a new version of function ${slug}...`);
            fn = yield* braintrust.replaceFunction(body);
          }

          return toAttributes(fn);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteFunction({ function_id: output.functionId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const fns = yield* Stream.runCollect(braintrust.listFunctions.items({}));
          // Prompt-backed functions belong to Braintrust.Prompt.
          return fns
            .filter(
              (fn) => isGeneratedName(fn.slug) && managedTypes.includes(fn.function_data.type),
            )
            .map(toAttributes);
        }),
      };
    }),
  );
