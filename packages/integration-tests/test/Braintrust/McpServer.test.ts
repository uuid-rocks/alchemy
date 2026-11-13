import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import type { InputProps } from "alchemy/Input";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { testName } from "../names.ts";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:mcp-server", "live"];

// Registration never contacts the server, so example.com URLs are enough.
const getMcpServer = (mcpServerId: string) =>
  braintrust.getMcpServer({ mcp_server_id: mcpServerId });

const expectMcpServerGone = (mcpServerId: string) =>
  Effect.gen(function* () {
    const exists = yield* getMcpServer(mcpServerId).pipe(
      Effect.map(() => true),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed(false)),
      Effect.repeat({ schedule: Schedule.spaced("1 second"), until: (found) => !found, times: 10 }),
    );
    expect(exists).toBe(false);
  });

const inProject = (props: InputProps<Omit<Braintrust.McpServerProps, "projectId">>) =>
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Project", {});
    return yield* Braintrust.McpServer("McpServer", { projectId: project.projectId, ...props });
  });

test.provider(
  "create an MCP server, update and clear its fields in place, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const props = { url: "https://mcp.example.com/mcp", description: "first" };
      const server = yield* stack.deploy(inProject(props));
      const created = yield* getMcpServer(server.mcpServerId);
      expect(created.name).toBe(server.name);
      expect(created.project_id).toBe(server.projectId);
      expect(created.url).toBe("https://mcp.example.com/mcp");
      expect(created.description).toBe("first");
      yield* expectFound(
        Braintrust.McpServer.lookup({ projectId: server.projectId, name: server.name }),
        server,
      );

      const plan = yield* stack.plan(inProject(props));
      expect(plan.resources.McpServer.action).toBe("noop");

      // Changing only the description leaves the URL alone.
      const described = yield* stack.deploy(inProject({ ...props, description: "second" }));
      expect(described.mcpServerId).toBe(server.mcpServerId);
      const observed = yield* getMcpServer(server.mcpServerId);
      expect(observed.description).toBe("second");
      expect(observed.url).toBe("https://mcp.example.com/mcp");

      // A new path on the same origin updates in place; clear the description.
      const moved = yield* stack.deploy(inProject({ url: "https://mcp.example.com/v2/mcp" }));
      expect(moved.mcpServerId).toBe(server.mcpServerId);
      const after = yield* getMcpServer(server.mcpServerId);
      expect(after.url).toBe("https://mcp.example.com/v2/mcp");
      expect(after.description || undefined).toBeUndefined();
      expect(moved.description).toBeUndefined();

      yield* stack.destroy();
      yield* expectMcpServerGone(server.mcpServerId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a new origin or another project replaces an MCP server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Both projects stay deployed across the replacements.
      const program = (target: "A" | "B", url: string) =>
        Effect.gen(function* () {
          const a = yield* Braintrust.Project("A", {});
          const b = yield* Braintrust.Project("B", {});
          return yield* Braintrust.McpServer("Moving", {
            projectId: target === "A" ? a.projectId : b.projectId,
            url,
          });
        });

      const first = yield* stack.deploy(program("A", "https://mcp.example.com/mcp"));
      const reoriginated = yield* stack.deploy(program("A", "https://tools.example.com/mcp"));
      expect(reoriginated.mcpServerId).not.toBe(first.mcpServerId);
      expect((yield* getMcpServer(reoriginated.mcpServerId)).url).toBe(
        "https://tools.example.com/mcp",
      );
      yield* expectMcpServerGone(first.mcpServerId);

      const moved = yield* stack.deploy(program("B", "https://tools.example.com/mcp"));
      expect(moved.mcpServerId).not.toBe(reoriginated.mcpServerId);
      expect((yield* getMcpServer(moved.mcpServerId)).project_id).toBe(moved.projectId);
      yield* expectMcpServerGone(reoriginated.mcpServerId);

      yield* stack.destroy();
      yield* expectMcpServerGone(moved.mcpServerId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a Redacted URL stays Redacted in the attributes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const url = "https://mcp.example.com/s/secret-token-12345/mcp";
      const server = yield* stack.deploy(inProject({ url: Redacted.make(url) }));
      expect(Redacted.isRedacted(server.url)).toBe(true);
      expect(JSON.stringify(server)).not.toContain("secret-token-12345");
      expect((yield* getMcpServer(server.mcpServerId)).url).toBe(url);

      const plan = yield* stack.plan(inProject({ url: Redacted.make(url) }));
      expect(plan.resources.McpServer.action).toBe("noop");

      yield* stack.destroy();
      yield* expectMcpServerGone(server.mcpServerId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "renaming an explicitly named MCP server keeps its id",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const url = "https://mcp.example.com/mcp";
      const server = yield* stack.deploy(
        inProject({ name: testName("alchemy-test-bt-mcp-a"), url }),
      );
      const renamed = yield* stack.deploy(
        inProject({ name: testName("alchemy-test-bt-mcp-b"), url }),
      );
      expect(renamed.mcpServerId).toBe(server.mcpServerId);
      expect((yield* getMcpServer(server.mcpServerId)).name).toBe(
        testName("alchemy-test-bt-mcp-b"),
      );

      yield* stack.destroy();
      yield* expectMcpServerGone(server.mcpServerId);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "an MCP server with an explicit name created elsewhere is refused unless adopted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName("alchemy-test-bt-foreign-mcp");

      const project = yield* stack.deploy(Braintrust.Project("Project", {}));
      const foreign = yield* braintrust.createMcpServer({
        project_id: project.projectId,
        name,
        url: "https://mcp.example.com/mcp",
      });

      const app = (allow: boolean) =>
        inProject({ name, url: "https://mcp.example.com/mcp", description: "adopted" }).pipe(
          adopt(allow),
        );

      const refused = yield* stack.deploy(app(false)).pipe(Effect.result);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure).toBeInstanceOf(OwnedBySomeoneElse);

      const adopted = yield* stack.deploy(app(true));
      expect(adopted.mcpServerId).toBe(foreign.id);
      expect((yield* getMcpServer(foreign.id)).description).toBe("adopted");

      yield* stack.destroy();
      yield* expectMcpServerGone(foreign.id);
    }),
  { tags, timeout: 120_000 },
);
