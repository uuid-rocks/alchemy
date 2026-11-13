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

export interface PromptProps {
  /**
   * Id of the project the prompt belongs to, e.g. `project.projectId`.
   * Changing it replaces the prompt, and every version of the old one is
   * deleted with it.
   */
  projectId: string;
  /**
   * Slug the prompt is invoked and loaded by, unique within the project. If
   * omitted, a unique slug is generated from the stack, stage and logical
   * ID. Changing it updates the prompt in place and appends a version.
   */
  slug?: string;
  /**
   * Display name of the prompt.
   * @default the slug
   */
  name?: string;
  /** Textual description of the prompt. Removing it clears the description. */
  description?: string;
  /**
   * The prompt itself: the `prompt` block (`chat` messages or a
   * `completion` string), the model and its parameters in `options`, and
   * optionally a `parser` (LLM classifier scorers), `tool_functions` the
   * model may call, `template_format` and `mcp` servers. Written as a
   * whole: a field removed here is removed from the next version.
   */
  promptData: braintrust.PromptDataNullish;
  /** Tags for the prompt. Removing them clears the tags. */
  tags?: string[];
  /**
   * What the prompt is used as when invoked as a function: `llm` (a plain
   * prompt), `scorer` (an LLM-as-a-judge scorer, with a `parser` in
   * `promptData`), `tool` (callable by other prompts), `task`,
   * `classifier`, and so on.
   */
  functionType?: braintrust.FunctionTypeEnumNullish;
}

export interface PromptAttributes {
  /** Unique identifier of the prompt; the same across versions. */
  promptId: string;
  /** Id of the project the prompt belongs to. */
  projectId: string;
  /** Slug the prompt is invoked and loaded by. */
  slug: string;
  /** Display name of the prompt. */
  name: string;
  /** Textual description of the prompt. */
  description: string | undefined;
  /** The prompt block, model, parameters, parser and tools. */
  promptData: braintrust.PromptDataNullish | undefined;
  /** Tags for the prompt. */
  tags: string[];
  /** What the prompt is used as when invoked as a function. */
  functionType: braintrust.FunctionTypeEnumNullish | undefined;
  /**
   * Transaction id of the current version (`_xact_id`). It changes on
   * every write; pass it as `version` to load this exact version.
   */
  version: string;
  /** When the prompt was created (ISO 8601). */
  created: string | undefined;
}

export type Prompt = Resource<
  "Braintrust.Prompt",
  PromptProps,
  PromptAttributes,
  never,
  Providers,
  PromptLookup
>;

/**
 * Props for {@link Prompt.lookup}: find a prompt this stack doesn't manage
 * by its project and slug.
 */
export interface PromptLookup {
  /** Id of the project the prompt belongs to. */
  projectId: string;
  /** Slug of the prompt. */
  slug: string;
}

/**
 * A Braintrust prompt: a versioned chat or completion template with its
 * model and parameters, loaded by slug from code (`loadPrompt`) or invoked
 * through the API. The same object serves as an LLM-as-a-judge scorer or a
 * tool when `functionType` says so. See
 * [Prompts](https://www.braintrust.dev/docs/guides/functions/prompts).
 *
 * Every write to a prompt appends a version, so Alchemy writes only when
 * the deployed prompt differs from the props, and then writes the whole
 * prompt once. The `version` attribute moves with each write.
 *
 * Prompts carry no labels Alchemy can use for ownership, so a prompt found
 * under an explicit `slug` with no prior state is refused unless adopted.
 *
 * :::caution
 * Changing `projectId` replaces the prompt. Every version of the old prompt
 * is deleted with it.
 * :::
 *
 * :::caution
 * Braintrust stores prompt versions as logs, so creating or changing a
 * prompt fails with `PaymentRequired` while the organization is out of log
 * credits.
 * :::
 *
 * ### Creating a Prompt
 * **Example:** Chat prompt with a model and parameters
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const summarize = yield* Braintrust.Prompt("Summarize", {
 *   projectId: project.projectId,
 *   slug: "summarize-ticket",
 *   promptData: {
 *     prompt: {
 *       type: "chat",
 *       messages: [
 *         { role: "system", content: "Summarize the ticket in one sentence." },
 *         { role: "user", content: "{{input}}" },
 *       ],
 *     },
 *     options: { model: "gpt-4o-mini", params: { temperature: 0 } },
 *   },
 * });
 * ```
 *
 * **Example:** Completion prompt with a description and tags
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const greeting = yield* Braintrust.Prompt("Greeting", {
 *   projectId: project.projectId,
 *   description: "Opening line for new tickets",
 *   tags: ["support"],
 *   promptData: {
 *     prompt: { type: "completion", content: "Greet {{name}} politely." },
 *     options: { model: "gpt-4o-mini" },
 *   },
 * });
 * ```
 *
 * ### Scoring with an LLM judge
 * **Example:** Prompt used as a scorer
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const politeness = yield* Braintrust.Prompt("Politeness", {
 *   projectId: project.projectId,
 *   slug: "politeness",
 *   functionType: "scorer",
 *   promptData: {
 *     prompt: {
 *       type: "chat",
 *       messages: [
 *         { role: "user", content: "Is this reply polite? {{output}} Answer Yes or No." },
 *       ],
 *     },
 *     options: { model: "gpt-4o-mini" },
 *     parser: { type: "llm_classifier", use_cot: true, choice_scores: { Yes: 1, No: 0 } },
 *   },
 * });
 * ```
 *
 * ### Calling tools
 * **Example:** Prompt that can call a code function
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const lookupOrder = yield* Braintrust.Function("LookupOrder", {
 *   projectId: project.projectId,
 *   functionType: "tool",
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
 * ### Loading a prompt version from code
 * **Example:** Pin the deployed version
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const summarize = yield* Braintrust.Prompt("Summarize", {
 *   projectId: project.projectId,
 *   slug: "summarize-ticket",
 *   promptData: {
 *     prompt: { type: "completion", content: "Summarize: {{input}}" },
 *     options: { model: "gpt-4o-mini" },
 *   },
 * });
 * // Pass both to `loadPrompt({ projectId, slug, version })` in your app.
 * const version = summarize.version;
 * ```
 *
 * ### Looking up an existing prompt
 * **Example:** Reference a prompt made in the Braintrust UI
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const prompt = Braintrust.Prompt.lookup({
 *   projectId: project.projectId,
 *   slug: "summarize-ticket",
 * });
 * ```
 *
 * @resource
 * @product Prompt
 */
export const Prompt = Resource<Prompt>("Braintrust.Prompt");

const toAttributes = (prompt: braintrust.Prompt): PromptAttributes => ({
  promptId: prompt.id,
  projectId: prompt.project_id,
  slug: prompt.slug,
  name: prompt.name,
  description: prompt.description || undefined,
  promptData: prompt.prompt_data ?? undefined,
  tags: [...(prompt.tags ?? [])],
  functionType: prompt.function_type ?? undefined,
  version: prompt._xact_id,
  created: prompt.created ?? undefined,
});

const getById = (promptId: string) =>
  braintrust
    .getPrompt({ prompt_id: promptId })
    .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined));

const findBySlug = (projectId: string, slug: string) =>
  braintrust.listPrompts.items({ project_id: projectId, slug }).pipe(
    Stream.filter((prompt) => prompt.project_id === projectId && prompt.slug === slug),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const PromptProvider = () =>
  Provider.effect(
    Prompt,
    Effect.gen(function* () {
      return {
        stables: ["promptId", "projectId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.projectId !== olds.projectId) return { action: "replace" } as const;
        }),
        lookup: Effect.fn(function* ({ projectId, slug }) {
          const prompt = yield* findBySlug(projectId, slug);
          return prompt ? toAttributes(prompt) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const prompt = yield* getById(output.promptId);
            return prompt ? toAttributes(prompt) : undefined;
          }
          const slug = yield* braintrustName(id, olds.slug);
          const prompt = yield* findBySlug(olds.projectId, slug);
          if (!prompt) return undefined;
          const attrs = toAttributes(prompt);
          // A generated slug carries this instance's suffix, so it is ours.
          return olds.slug === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "promptId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const slug = yield* braintrustName(id, news.slug);
          // The whole prompt, with explicit empty values so a removed field
          // is cleared from the version this writes.
          const body = {
            project_id: news.projectId,
            slug,
            name: news.name ?? slug,
            description: news.description ?? null,
            prompt_data: news.promptData,
            tags: news.tags ?? [],
            function_type: news.functionType ?? null,
          };

          // Observe — by id once we have one (it survives slug changes),
          // else by slug.
          const cached = output ? yield* getById(output.promptId) : undefined;
          let prompt =
            (cached?.project_id === news.projectId ? cached : undefined) ??
            (yield* findBySlug(news.projectId, slug));

          // Ensure — POST on a taken slug appends a version to that prompt
          // instead of failing, so a concurrent create converges on one.
          if (!prompt) {
            yield* session.note(`Creating prompt ${slug}...`);
            prompt = yield* braintrust.createPrompt(body);
          }

          // Sync — every write appends a version, so compare first. Only
          // PATCH changes the slug of an existing prompt.
          if (prompt.slug !== slug) {
            yield* session.note(`Changing prompt slug to ${slug}...`);
            prompt = yield* braintrust.updatePrompt({ prompt_id: prompt.id, slug });
          }
          // PATCH deep-merges `prompt_data` and can't remove a field, so a
          // content change PUTs the whole prompt: one version on this slug.
          const observed = toAttributes(prompt);
          const unchanged =
            observed.name === body.name &&
            observed.description === news.description &&
            deepEqual(observed.tags, body.tags) &&
            deepEqual(observed.promptData, news.promptData, { stripNullish: true }) &&
            observed.functionType === news.functionType;
          if (!unchanged) {
            yield* session.note(`Writing a new version of prompt ${slug}...`);
            prompt = yield* braintrust.replacePrompt(body);
          }

          return toAttributes(prompt);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deletePrompt({ prompt_id: output.promptId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const prompts = yield* Stream.runCollect(braintrust.listPrompts.items({}));
          return prompts.filter((prompt) => isGeneratedName(prompt.slug)).map(toAttributes);
        }),
      };
    }),
  );
