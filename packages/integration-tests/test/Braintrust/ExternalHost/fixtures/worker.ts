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
    const logs = yield* Braintrust.ReadWriteProjectLogs(project);
    const experiment = yield* Braintrust.ReadExperiment(yield* Experiment);
    const dataset = yield* Braintrust.ReadWriteDataset(yield* Dataset);
    const launch = yield* Braintrust.LaunchEval(project);
    const chat = yield* Braintrust.ProxyChatCompletions(yield* Secret);

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
                restored: dataset.restore({ version: "1000192345678901" }),
              }),
            );
          case "/dataset/insert":
            return yield* respond(
              dataset.insert({ events: [{ id: "worker-record", input: "q" }] }),
            );
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
      ),
    ),
  ),
) {}
