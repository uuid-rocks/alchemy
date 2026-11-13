import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { unownedUnlessPrevious } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { braintrustName, isGeneratedName, unlessDeleted } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

export interface McpServerProps {
  /**
   * Id of the project the server belongs to, e.g. `project.projectId`.
   * Changing it replaces the server.
   */
  projectId: string;
  /**
   * Server name, unique within the project. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Renaming updates the
   * server in place.
   */
  name?: string;
  /**
   * The server's HTTP(S) endpoint. Pass a `Redacted` string when the URL
   * itself carries a credential; the `url` attribute then stays `Redacted`
   * too. A new path on the same origin updates the server in place; a new
   * origin replaces it.
   */
  url: string | Redacted.Redacted<string>;
  /** Textual description of the server. Removing it clears the description. */
  description?: string;
}

export interface McpServerAttributes {
  /** Unique identifier of the server. */
  mcpServerId: string;
  /** Id of the project the server belongs to. */
  projectId: string;
  /** Server name. */
  name: string;
  /** The server's endpoint, `Redacted` when the props passed it `Redacted`. */
  url: string | Redacted.Redacted<string>;
  /** Textual description of the server. */
  description: string | undefined;
  /** When the server was created (ISO 8601). */
  created: string | undefined;
}

export type McpServer = Resource<
  "Braintrust.McpServer",
  McpServerProps,
  McpServerAttributes,
  never,
  Providers,
  McpServerLookup
>;

/**
 * Props for {@link McpServer.lookup}: find a server this stack doesn't
 * manage by its project and name.
 */
export interface McpServerLookup {
  /** Id of the project the server belongs to. */
  projectId: string;
  /** Server name. */
  name: string;
}

/**
 * A remote MCP server registered in a Braintrust project, whose tools
 * prompts and Loop can call. See
 * [MCP servers in prompts](https://www.braintrust.dev/docs/evaluate/prompts/create).
 *
 * Braintrust authenticates to the server with OAuth, connected per user or
 * shared for the project in the Braintrust UI; the API has no call to set
 * those credentials, so Alchemy manages the registration only. A token for
 * one call goes in the request's `mcp_auth` when invoking a prompt or
 * running an eval. If the server's URL itself embeds a credential, pass it
 * as a `Redacted` string.
 *
 * Servers carry no tags Alchemy can use for ownership, so a server found
 * under an explicit `name` with no prior state is refused unless adopted.
 * Deleting the project deletes its servers.
 *
 * :::caution
 * Changing `projectId`, or moving `url` to another origin (scheme, host or
 * port), replaces the server: Braintrust refuses to change an origin.
 * :::
 *
 * ### Registering an MCP server
 * **Example:** Public MCP server
 * ```typescript
 * const project = yield* Braintrust.Project("Support", {});
 * const docs = yield* Braintrust.McpServer("Docs", {
 *   projectId: project.projectId,
 *   url: "https://mcp.example.com/mcp",
 *   description: "Product documentation search",
 * });
 * ```
 *
 * **Example:** Server whose URL embeds a credential
 * ```typescript
 * import * as Config from "effect/Config";
 *
 * const project = yield* Braintrust.Project("Support", {});
 * const tools = yield* Braintrust.McpServer("Tools", {
 *   projectId: project.projectId,
 *   url: yield* Config.redacted("TOOLS_MCP_URL"),
 * });
 * ```
 *
 * ### Looking up an existing server
 * **Example:** Reference a server registered in the Braintrust UI
 * ```typescript
 * const project = Braintrust.Project.lookup({ name: "My Project" });
 * const docs = Braintrust.McpServer.lookup({
 *   projectId: project.projectId,
 *   name: "Docs",
 * });
 * ```
 *
 * @resource
 * @product McpServer
 */
export const McpServer = Resource<McpServer>("Braintrust.McpServer");

const plain = (url: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(url) ? Redacted.value(url) : url;

// What Braintrust refuses to change. A URL that doesn't parse compares whole.
const originOf = (url: string) => (URL.canParse(url) ? new URL(url).origin : url);

/** `redact`: keep the observed URL `Redacted` when the props passed it that way. */
const toAttributes = (server: braintrust.MCPServer, redact: boolean): McpServerAttributes => ({
  mcpServerId: server.id,
  projectId: server.project_id,
  name: server.name,
  url: redact ? Redacted.make(server.url) : server.url,
  // Clearing stores "" (PATCH ignores null), which reads as no description.
  description: server.description || undefined,
  created: server.created ?? undefined,
});

const getById = (mcpServerId: string) =>
  braintrust.getMcpServer({ mcp_server_id: mcpServerId }).pipe(
    Effect.map(unlessDeleted),
    Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined),
  );

// The list filters by name across the organization, not by project.
const findByName = (projectId: string, name: string) =>
  braintrust.listMcpServers.items({ mcp_server_name: name }).pipe(
    Stream.filter(
      (server) => server.project_id === projectId && server.name === name && !server.deleted_at,
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

export const McpServerProvider = () =>
  Provider.effect(
    McpServer,
    Effect.gen(function* () {
      return {
        stables: ["mcpServerId", "projectId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.projectId !== olds.projectId ||
            originOf(plain(news.url)) !== originOf(plain(olds.url))
          ) {
            return { action: "replace" } as const;
          }
        }),
        lookup: Effect.fn(function* ({ projectId, name }) {
          const server = yield* findByName(projectId, name);
          return server ? toAttributes(server, false) : undefined;
        }),
        read: Effect.fn(function* ({ id, olds, output, previous }) {
          const redact = Redacted.isRedacted(olds.url);
          if (output) {
            const server = yield* getById(output.mcpServerId);
            return server ? toAttributes(server, redact) : undefined;
          }
          const server = yield* findByName(olds.projectId, yield* braintrustName(id, olds.name));
          if (!server) return undefined;
          const attrs = toAttributes(server, redact);
          // A generated name carries this instance's suffix, so it is ours.
          return olds.name === undefined
            ? attrs
            : unownedUnlessPrevious(attrs, previous, "mcpServerId");
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* braintrustName(id, news.name);
          const url = plain(news.url);

          // Observe — by id once we have one (it survives renames), else by name.
          const cached = output ? yield* getById(output.mcpServerId) : undefined;
          let server =
            (cached?.project_id === news.projectId ? cached : undefined) ??
            (yield* findByName(news.projectId, name));

          // Ensure — POST returns the existing server of the same name
          // unchanged, so a concurrent create converges on one server.
          if (!server) {
            yield* session.note(`Creating MCP server ${name}...`);
            server = yield* braintrust.createMcpServer({
              project_id: news.projectId,
              name,
              url,
              description: news.description,
            });
          }

          // Sync — PATCH only the fields that differ. PATCH ignores `null`,
          // so an empty string clears the description.
          const update: Omit<braintrust.UpdateMcpServerRequest, "mcp_server_id"> = {};
          if (server.name !== name) update.name = name;
          if (server.url !== url) update.url = url;
          if ((server.description || undefined) !== news.description) {
            update.description = news.description ?? "";
          }
          if (Object.keys(update).length > 0) {
            yield* session.note(`Updating MCP server ${name}...`);
            server = yield* braintrust.updateMcpServer({ mcp_server_id: server.id, ...update });
          }

          return toAttributes(server, Redacted.isRedacted(news.url));
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* braintrust
            .deleteMcpServer({ mcp_server_id: output.mcpServerId })
            .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const servers = yield* Stream.runCollect(braintrust.listMcpServers.items({}));
          return (
            servers
              .filter((server) => !server.deleted_at && isGeneratedName(server.name))
              // Without props, any listed URL may carry a credential.
              .map((server) => toAttributes(server, true))
          );
        }),
      };
    }),
  );
