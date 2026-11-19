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
    // One binding per operation, each called by its own route below.
    const insertLogs = yield* Braintrust.InsertProjectLogs(project);
    const fetchLogs = yield* Braintrust.FetchProjectLogs(project);
    const logFeedback = yield* Braintrust.ProjectLogFeedback(project);
    const readLogs = yield* Braintrust.ReadProjectLogs(project);
    const insertExperiment = yield* Braintrust.InsertExperimentEvents(boundExperiment);
    const fetchExperiment = yield* Braintrust.FetchExperimentEvents(boundExperiment);
    const experimentFeedback = yield* Braintrust.ExperimentFeedback(boundExperiment);
    const summarizeExperiment = yield* Braintrust.SummarizeExperiment(boundExperiment);
    const readWriteExperiment = yield* Braintrust.ReadWriteExperiment(boundExperiment);
    const insertDataset = yield* Braintrust.InsertDatasetEvents(boundDataset);
    const fetchDataset = yield* Braintrust.FetchDatasetEvents(boundDataset);
    const datasetFeedback = yield* Braintrust.DatasetFeedback(boundDataset);
    const summarizeDataset = yield* Braintrust.SummarizeDataset(boundDataset);
    const previewRestore = yield* Braintrust.PreviewDatasetRestore(boundDataset);
    const readDataset = yield* Braintrust.ReadDataset(boundDataset);
    const writeDataset = yield* Braintrust.WriteDataset(boundDataset);
    const complete = yield* Braintrust.ProxyCompletions(secret);
    const embed = yield* Braintrust.ProxyEmbeddings(secret);
    const auto = yield* Braintrust.ProxyAuto(secret);
    const proxy = yield* Braintrust.ProxyRequest(secret);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    // The OpenAI secret is fake, so a call that reaches OpenAI fails; the
    // route reports the failure for the test to check where it came from.
    const reached = <A, E extends { readonly _tag: string; readonly message?: string }>(
      call: Effect.Effect<A, E, RuntimeContext>,
    ) =>
      call.pipe(
        Effect.flip,
        Effect.map((error) => ({ tag: error._tag, message: String(error.message ?? "") })),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const id = url.searchParams.get("id") ?? "";
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
          case "/InsertProjectLogs":
            return yield* respond(insertLogs({ events: [{ id, input: "q" }] }));
          case "/FetchProjectLogs":
            return yield* respond(fetchLogs());
          case "/ProjectLogFeedback":
            return yield* respond(logFeedback({ feedback: [{ id, scores: { helpful: 1 } }] }));
          case "/ReadProjectLogs":
            return yield* respond(readLogs.fetch());
          case "/InsertExperimentEvents":
            return yield* respond(insertExperiment({ events: [{ id, input: "q", output: "a" }] }));
          case "/FetchExperimentEvents":
            return yield* respond(fetchExperiment());
          case "/ExperimentFeedback":
            return yield* respond(experimentFeedback({ feedback: [{ id, comment: "checked" }] }));
          case "/SummarizeExperiment":
            return yield* respond(summarizeExperiment({ summarize_scores: true }));
          case "/ReadWriteExperiment":
            return yield* respond(
              Effect.all({
                inserted: readWriteExperiment.insert({ events: [{ id, input: "q", output: "a" }] }),
                page: readWriteExperiment.fetch(),
              }),
            );
          case "/InsertDatasetEvents":
            return yield* respond(insertDataset({ events: [{ id, input: "q" }] }));
          case "/FetchDatasetEvents":
            return yield* respond(fetchDataset());
          case "/DatasetFeedback":
            return yield* respond(datasetFeedback({ feedback: [{ id, comment: "checked" }] }));
          case "/SummarizeDataset":
            return yield* respond(summarizeDataset({ summarize_data: true }));
          case "/PreviewDatasetRestore":
            return yield* respond(
              previewRestore({ version: url.searchParams.get("version") ?? "" }),
            );
          case "/ReadDataset":
            return yield* respond(
              Effect.all({
                page: readDataset.fetch(),
                summary: readDataset.summarize({ summarize_data: true }),
              }),
            );
          case "/WriteDataset":
            return yield* respond(
              Effect.all({
                inserted: writeDataset.insert({ events: [{ id, input: "q", expected: "a" }] }),
                feedback: writeDataset.feedback({ feedback: [{ id, comment: "checked" }] }),
              }),
            );
          case "/ProxyCompletions":
            return yield* respond(
              reached(complete({ model: "gpt-3.5-turbo-instruct", prompt: "hi" })),
            );
          case "/ProxyEmbeddings":
            return yield* respond(reached(embed({ model: "text-embedding-3-small", input: "hi" })));
          case "/ProxyAuto":
            return yield* respond(
              reached(auto({ model: "gpt-4.1-nano", messages: [{ role: "user", content: "hi" }] })),
            );
          case "/ProxyRequest":
            return yield* respond(
              reached(proxy({ path: "responses", model: "gpt-4.1-mini", input: "hi" })),
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
        Braintrust.InsertProjectLogsHttp,
        Braintrust.FetchProjectLogsHttp,
        Braintrust.ProjectLogFeedbackHttp,
        Braintrust.ReadProjectLogsHttp,
        Braintrust.InsertExperimentEventsHttp,
        Braintrust.FetchExperimentEventsHttp,
        Braintrust.ExperimentFeedbackHttp,
        Braintrust.SummarizeExperimentHttp,
        Braintrust.ReadWriteExperimentHttp,
        Braintrust.InsertDatasetEventsHttp,
        Braintrust.FetchDatasetEventsHttp,
        Braintrust.DatasetFeedbackHttp,
        Braintrust.SummarizeDatasetHttp,
        Braintrust.PreviewDatasetRestoreHttp,
        Braintrust.ReadDatasetHttp,
        Braintrust.WriteDatasetHttp,
        Braintrust.ProxyCompletionsHttp,
        Braintrust.ProxyEmbeddingsHttp,
        Braintrust.ProxyAutoHttp,
        Braintrust.ProxyRequestHttp,
      ),
    ),
  ),
) {}
