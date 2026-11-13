import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { braintrustName, isGeneratedName, unlessDeleted } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface SpanIframeProps {
  /**
   * Id of the project the span iframe belongs to, e.g. `project.projectId`.
   * Changing it replaces the span iframe.
   */
  projectId: string;
  /**
   * Span iframe name, unique within the project. If omitted, a unique name
   * is generated from the stack, stage and logical ID. Renaming updates the
   * span iframe in place.
   */
  name?: string;
  /** URL of the page to embed next to each span. */
  url: string;
  /** Textual description of the span iframe. Removing it clears the description. */
  description?: string;
  /**
   * Post a message with the span's data to the iframe, for pages that
   * render more than fits in the URL.
   * @default false
   */
  postMessage?: boolean;
}

export interface SpanIframeAttributes {
  /** Unique identifier of the span iframe. */
  spanIframeId: string;
  /** Id of the project the span iframe belongs to. */
  projectId: string;
  /** Span iframe name. */
  name: string;
  /** URL of the embedded page. */
  url: string;
  /** Textual description of the span iframe. */
  description: string | undefined;
  /** Whether the span's data is posted to the iframe. */
  postMessage: boolean;
  /** When the span iframe was created (ISO 8601). */
  created: string | undefined;
}

export type SpanIframe = Resource<
  "Braintrust.SpanIframe",
  SpanIframeProps,
  SpanIframeAttributes,
  never,
  Providers,
  SpanIframeLookup
>;

/**
 * Props for {@link SpanIframe.lookup}: find a span iframe this stack doesn't
 * manage by its project and name.
 */
export interface SpanIframeLookup {
  /** Id of the project the span iframe belongs to. */
  projectId: string;
  /** Span iframe name. */
  name: string;
}

/**
 * A Braintrust span iframe: a custom page embedded next to every span in a
 * project's traces, to render span data your way. See
 * [Custom span iframes](https://www.braintrust.dev/docs/guides/traces/customize#custom-span-iframes).
 *
 * Span iframes carry no labels Alchemy can use for ownership, so one found
 * under an explicit `name` with no prior state is refused unless adopted.
 *
 * :::caution
 * Changing `projectId` replaces the span iframe.
 * :::
 *
 * ### Creating a Span Iframe
 * **Example:** Embed a page that renders each span
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const iframe = yield* Braintrust.SpanIframe("Viewer", {
 *   projectId: project.projectId,
 *   name: "Conversation viewer",
 *   url: "https://viewer.example.com/span",
 *   postMessage: true,
 * });
 * ```
 *
 * ### Looking up an existing span iframe
 * **Example:** Reference a span iframe made in the Braintrust UI
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const iframe = Braintrust.SpanIframe.lookup({
 *   projectId: project.projectId,
 *   name: "Conversation viewer",
 * });
 * ```
 *
 * @resource
 * @product Span Iframe
 */
export const SpanIframe = Resource<SpanIframe>("Braintrust.SpanIframe");

const toAttributes = (iframe: braintrust.SpanIFrame): SpanIframeAttributes => ({
  spanIframeId: iframe.id,
  projectId: iframe.project_id,
  name: iframe.name,
  url: iframe.url,
  // A PATCH can't null the description, so a cleared one reads back as "".
  description: iframe.description || undefined,
  postMessage: iframe.post_message ?? false,
  created: iframe.created ?? undefined,
});

const getById = (spanIframeId: string) =>
  braintrust.getSpanIframe({ span_iframe_id: spanIframeId }).pipe(
    Effect.map(unlessDeleted),
    Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined),
  );

// The list takes no project filter; filter by project client-side.
const findByName = (projectId: string, name: string) =>
  braintrust.listSpanIframes.items({ span_iframe_name: name }).pipe(
    Stream.filter(
      (iframe) => iframe.project_id === projectId && iframe.name === name && !iframe.deleted_at,
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const SpanIframeProvider = () =>
  Provider.effect(
    SpanIframe,
    Effect.gen(function* () {
      return {
        stables: ["spanIframeId", "projectId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.projectId !== olds.projectId) return { action: "replace" } as const;
        }),
        lookup: Effect.fn(function* ({ projectId, name }) {
          const iframe = yield* findByName(projectId, name);
          return iframe ? toAttributes(iframe) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          if (output) {
            const iframe = yield* getById(output.spanIframeId);
            return iframe ? toAttributes(iframe) : undefined;
          }
          const name = yield* braintrustName(id, olds.name);
          const iframe = yield* findByName(olds.projectId, name);
          if (!iframe) return undefined;
          const attrs = toAttributes(iframe);
          // A generated name carries this instance's suffix, so it is ours.
          return olds.name === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "spanIframeId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* braintrustName(id, news.name);

          // Observe — by id once we have one (it survives renames), else by name.
          const cached = output ? yield* getById(output.spanIframeId) : undefined;
          let iframe =
            (cached?.project_id === news.projectId ? cached : undefined) ??
            (yield* findByName(news.projectId, name));

          // Ensure — POST returns the existing span iframe of the same name
          // unchanged, so a concurrent create converges on one.
          if (!iframe) {
            yield* session.note(`Creating span iframe ${name}...`);
            iframe = yield* braintrust.createSpanIframe({
              project_id: news.projectId,
              name,
              url: news.url,
              description: news.description,
              post_message: news.postMessage,
            });
          }

          // Sync — PATCH only the fields that differ from what is deployed.
          // The API ignores `null`; an empty string clears the description.
          const update: Omit<braintrust.UpdateSpanIframeRequest, "span_iframe_id"> = {};
          if (iframe.name !== name) update.name = name;
          if (iframe.url !== news.url) update.url = news.url;
          if ((iframe.description || undefined) !== news.description) {
            update.description = news.description ?? "";
          }
          if ((iframe.post_message ?? false) !== (news.postMessage ?? false)) {
            update.post_message = news.postMessage ?? false;
          }
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating span iframe ${name}...`);
            iframe = yield* braintrust.updateSpanIframe({ span_iframe_id: iframe.id, ...update });
          }

          return toAttributes(iframe);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteSpanIframe({ span_iframe_id: output.spanIframeId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const iframes = yield* Stream.runCollect(braintrust.listSpanIframes.items({}));
          return iframes
            .filter((iframe) => !iframe.deleted_at && isGeneratedName(iframe.name))
            .map(toAttributes);
        }),
      };
    }),
  );
