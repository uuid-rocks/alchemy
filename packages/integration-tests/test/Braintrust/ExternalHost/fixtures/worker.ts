import * as Braintrust from "@alchemy.run/braintrust";
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const Project = Braintrust.Project("ExternalHostProject", {});

export const Experiment = Effect.gen(function* () {
  const project = yield* Project;
  return yield* Braintrust.Experiment("ExternalHostExperiment", { projectId: project.projectId });
});

export const Dataset = Effect.gen(function* () {
  const project = yield* Project;
  return yield* Braintrust.Dataset("ExternalHostDataset", { projectId: project.projectId });
});

export const Echo = Effect.gen(function* () {
  const project = yield* Project;
  return yield* Braintrust.Function("ExternalHostEcho", {
    projectId: project.projectId,
    functionData: {
      type: "code",
      data: {
        type: "inline",
        runtime_context: { runtime: "node", version: "20" },
        code: "async function handler(input) { return input; }",
      },
    },
  });
});

// Not a real OpenAI key: a call that reaches OpenAI with it is answered 401.
export const Secret = Braintrust.AiSecret("ExternalHostSecret", {
  type: "openai",
  secret: Redacted.make("sk-fake-not-a-key"),
});

/**
 * A Cloudflare Worker using Braintrust bindings: a host with no identity
 * Braintrust trusts, so the bindings give it its own service account and
 * token. One route per binding; each answers `{ ok, result | error }` so a
 * failure surfaces Braintrust's error in the test.
 */
export default class BraintrustWorker extends Cloudflare.Worker<BraintrustWorker>()(
  "BraintrustExternalHostWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const project = yield* Project;
    const boundExperiment = yield* Experiment;
    const boundDataset = yield* Dataset;
    const secret = yield* Secret;
    const echo = yield* Echo;
    const logs = yield* Braintrust.ReadWriteProjectLogs(project);
    const experiment = yield* Braintrust.ReadExperiment(boundExperiment);
    const dataset = yield* Braintrust.ReadWriteDataset(boundDataset);
    const launch = yield* Braintrust.LaunchEval(project);
    const chat = yield* Braintrust.ProxyChatCompletions(secret);
    const logWriter = yield* Braintrust.WriteProjectLogs(project);
    const experimentWriter = yield* Braintrust.WriteExperiment(boundExperiment);
    const restore = yield* Braintrust.RestoreDataset(boundDataset);
    const invoke = yield* Braintrust.InvokeFunction(echo);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        switch (url.pathname) {
          case "/logs":
            return yield* respond(logs.fetch({ limit: 10 }));
          case "/logs/insert":
            return yield* respond(logs.insert({ events: [{ id: "worker-log", input: "q" }] }));
          case "/experiment":
            return yield* respond(
              Effect.all({ page: experiment.fetch(), summary: experiment.summarize() }),
            );
          case "/dataset":
            return yield* respond(
              Effect.all({
                page: dataset.fetch(),
                summary: dataset.summarize({ summarize_data: true }),
              }),
            );
          case "/dataset/insert":
            return yield* respond(
              dataset.insert({
                events: [{ id: url.searchParams.get("id") ?? "worker-record", input: "q" }],
              }),
            );
          case "/dataset/restore":
            return yield* respond(restore({ version: url.searchParams.get("version") ?? "" }));
          case "/logs/write":
            return yield* respond(
              Effect.all({
                inserted: logWriter.insert({ events: [{ id: "worker-write-log", input: "q" }] }),
                feedback: logWriter.feedback({
                  feedback: [{ id: "worker-write-log", scores: { helpful: 1 } }],
                }),
              }),
            );
          case "/experiment/write":
            return yield* respond(
              Effect.all({
                inserted: experimentWriter.insert({
                  events: [{ id: "worker-result", input: "q", output: "a", scores: { ok: 1 } }],
                }),
                feedback: experimentWriter.feedback({
                  feedback: [{ id: "worker-result", comment: "checked" }],
                }),
              }),
            );
          case "/invoke":
            return yield* respond(invoke({ input: { echo: "hi" } }));
          case "/eval":
            return yield* respond(
              launch({
                data: { dataset_id: url.searchParams.get("dataset") ?? "" },
                task: { global_function: "ExactMatch" },
                scores: [{ global_function: "ExactMatch" }],
              }),
            );
          case "/proxy":
            return yield* respond(
              chat({ model: "gpt-4.1-mini", messages: [{ role: "user", content: "hi" }] }).pipe(
                Effect.flip,
                Effect.map((error) => ({ tag: error._tag, message: String(error.message ?? "") })),
              ),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Braintrust.ReadWriteProjectLogsHttp,
        Braintrust.ReadExperimentHttp,
        Braintrust.ReadWriteDatasetHttp,
        Braintrust.LaunchEvalHttp,
        Braintrust.ProxyChatCompletionsHttp,
        Braintrust.WriteProjectLogsHttp,
        Braintrust.WriteExperimentHttp,
        Braintrust.RestoreDatasetHttp,
        Braintrust.InvokeFunctionHttp,
      ),
    ),
  ),
) {}
