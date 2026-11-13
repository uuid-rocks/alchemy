import * as Braintrust from "@alchemy.run/braintrust";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import type * as Output from "alchemy/Output";
import { type BaseRuntimeContext, RuntimeContext } from "alchemy/RuntimeContext";
import { Self } from "alchemy/Self";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/**
 * Every Braintrust binding, run the way a deployed host runs it, without a
 * Cloudflare account: `host(...)` runs a host's init inside the stack
 * deploy, as the host's `Self`, so each binding creates the host's service
 * account, token and grants through the engine and binds the token into a
 * captured env; `inHost(...)` runs the same init again in the runtime phase
 * (`__ALCHEMY_RUNTIME__`) over the deployed env, and calls the clients with
 * the host's token. `ExternalHost/CloudflareWorker.test.ts` runs the same
 * bindings in a deployed Worker.
 */

const testOptions = { providers: Braintrust.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BraintrustBindings", import.meta.url);

const tags = ["provider:braintrust", "provider:braintrust:bindings", "live"];

interface Bound {
  project: Braintrust.Project;
  experiment: Braintrust.Experiment;
  dataset: Braintrust.Dataset;
  secret: Braintrust.AiSecret;
}

const Objects = Effect.gen(function* () {
  const project = yield* Braintrust.Project("Bound", {});
  const experiment = yield* Braintrust.Experiment("BoundExperiment", {
    projectId: project.projectId,
  });
  const dataset = yield* Braintrust.Dataset("BoundDataset", { projectId: project.projectId });
  // Not a real OpenAI key: a call that reaches OpenAI with it proves the
  // proxy used this secret, and OpenAI answers 401.
  const secret = yield* Braintrust.AiSecret("BoundSecret", {
    type: "openai",
    secret: Redacted.make("sk-fake-not-a-key"),
  });
  return { project, experiment, dataset, secret } satisfies Bound;
});

/** Objects no host is granted anything on. */
const Others = Effect.gen(function* () {
  const project = yield* Braintrust.Project("Other", {});
  const experiment = yield* Braintrust.Experiment("OtherExperiment", {
    projectId: project.projectId,
  });
  const dataset = yield* Braintrust.Dataset("OtherDataset", { projectId: project.projectId });
  return { project, experiment, dataset };
});

const readerInit = (b: Bound) =>
  Effect.gen(function* () {
    return {
      logs: yield* Braintrust.ReadProjectLogs(b.project),
      experiment: yield* Braintrust.ReadExperiment(b.experiment),
      dataset: yield* Braintrust.ReadDataset(b.dataset),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Braintrust.ReadProjectLogsHttp,
        Braintrust.ReadExperimentHttp,
        Braintrust.ReadDatasetHttp,
      ),
    ),
  );

const writerInit = (b: Bound) =>
  Effect.gen(function* () {
    return {
      logs: yield* Braintrust.WriteProjectLogs(b.project),
      experiment: yield* Braintrust.WriteExperiment(b.experiment),
      dataset: yield* Braintrust.WriteDataset(b.dataset),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Braintrust.WriteProjectLogsHttp,
        Braintrust.WriteExperimentHttp,
        Braintrust.WriteDatasetHttp,
      ),
    ),
  );

const readWriterInit = (b: Bound) =>
  Effect.gen(function* () {
    return {
      logs: yield* Braintrust.ReadWriteProjectLogs(b.project),
      experiment: yield* Braintrust.ReadWriteExperiment(b.experiment),
      dataset: yield* Braintrust.ReadWriteDataset(b.dataset),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Braintrust.ReadWriteProjectLogsHttp,
        Braintrust.ReadWriteExperimentHttp,
        Braintrust.ReadWriteDatasetHttp,
      ),
    ),
  );

/** One binding per operation, plus the eval and proxy bindings. */
const opsInit = (b: Bound) =>
  Effect.gen(function* () {
    return {
      insertLogs: yield* Braintrust.InsertProjectLogs(b.project),
      fetchLogs: yield* Braintrust.FetchProjectLogs(b.project),
      logFeedback: yield* Braintrust.ProjectLogFeedback(b.project),
      insertExperiment: yield* Braintrust.InsertExperimentEvents(b.experiment),
      fetchExperiment: yield* Braintrust.FetchExperimentEvents(b.experiment),
      experimentFeedback: yield* Braintrust.ExperimentFeedback(b.experiment),
      summarizeExperiment: yield* Braintrust.SummarizeExperiment(b.experiment),
      insertDataset: yield* Braintrust.InsertDatasetEvents(b.dataset),
      fetchDataset: yield* Braintrust.FetchDatasetEvents(b.dataset),
      datasetFeedback: yield* Braintrust.DatasetFeedback(b.dataset),
      summarizeDataset: yield* Braintrust.SummarizeDataset(b.dataset),
      previewRestore: yield* Braintrust.PreviewDatasetRestore(b.dataset),
      restore: yield* Braintrust.RestoreDataset(b.dataset),
      launchEval: yield* Braintrust.LaunchEval(b.project),
      chat: yield* Braintrust.ProxyChatCompletions(b.secret),
      complete: yield* Braintrust.ProxyCompletions(b.secret),
      embed: yield* Braintrust.ProxyEmbeddings(b.secret),
      auto: yield* Braintrust.ProxyAuto(b.secret),
      proxy: yield* Braintrust.ProxyRequest(b.secret),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Braintrust.InsertProjectLogsHttp,
        Braintrust.FetchProjectLogsHttp,
        Braintrust.ProjectLogFeedbackHttp,
        Braintrust.InsertExperimentEventsHttp,
        Braintrust.FetchExperimentEventsHttp,
        Braintrust.ExperimentFeedbackHttp,
        Braintrust.SummarizeExperimentHttp,
        Braintrust.InsertDatasetEventsHttp,
        Braintrust.FetchDatasetEventsHttp,
        Braintrust.DatasetFeedbackHttp,
        Braintrust.SummarizeDatasetHttp,
        Braintrust.PreviewDatasetRestoreHttp,
        Braintrust.RestoreDatasetHttp,
        Braintrust.LaunchEvalHttp,
        Braintrust.ProxyChatCompletionsHttp,
        Braintrust.ProxyCompletionsHttp,
        Braintrust.ProxyEmbeddingsHttp,
        Braintrust.ProxyAutoHttp,
        Braintrust.ProxyRequestHttp,
      ),
    ),
  );

const invokerInit = (fn: Braintrust.Function) =>
  Braintrust.InvokeFunction(fn).pipe(Effect.provide(Braintrust.InvokeFunctionHttp));

type Env = Record<string, unknown>;

/**
 * Runs a host's init at deploy, as host `id`: what its bindings bind lands in
 * the returned env, which the deploy resolves.
 */
const host = <A, E, R>(id: string, init: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const env: Record<string, Output.Output> = {};
    const runtime: BaseRuntimeContext = {
      Type: "Test.Host",
      id,
      env,
      set: (key, output) =>
        Effect.sync(() => {
          env[key] = output;
          return key;
        }),
      get: () => Effect.succeed(undefined),
    };
    yield* init.pipe(
      Effect.provideService(RuntimeContext, runtime),
      Effect.provideService(Self as unknown as Context.Service<object, object>, {
        Type: "Test.Host",
        LogicalId: id,
      }),
    );
    return env;
  });

/**
 * Runs a host's init in the runtime phase over `env`, the env its deploy
 * bound, and hands `use` the clients. Every call needs the host's
 * `RuntimeContext`, as inside a deployed host.
 */
const inHost = <C, A, E, R>(
  env: Env,
  init: Effect.Effect<C, never, R>,
  use: (clients: C) => Effect.Effect<A, E, RuntimeContext>,
) => {
  const runtime: BaseRuntimeContext = {
    Type: "Test.Host",
    id: "runtime",
    env,
    set: (key) => Effect.succeed(key),
    get: <T>(key: string) => Effect.succeed(env[key] as T | undefined),
  };
  return Effect.gen(function* () {
    const previous = yield* Effect.sync(() => {
      const was = globalThis.__ALCHEMY_RUNTIME__;
      globalThis.__ALCHEMY_RUNTIME__ = true;
      return was;
    });
    const clients = yield* init.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          globalThis.__ALCHEMY_RUNTIME__ = previous;
        }),
      ),
    );
    return yield* use(clients);
  }).pipe(Effect.provideService(RuntimeContext, runtime));
};

const keyOf = (env: Env) => env.BRAINTRUST_API_KEY as Redacted.Redacted<string>;

/** A distilled call made with a host's own token, outside its bindings. */
const asHost = <A, E>(
  env: Env,
  call: Effect.Effect<A, E, braintrust.BraintrustOpContext>,
): Effect.Effect<A, E> =>
  call.pipe(
    Effect.provide(
      Layer.mergeAll(Braintrust.fromApiKey({ apiKey: keyOf(env) }), FetchHttpClient.layer),
    ),
  );

/** The tag a call made with a host's token fails with. */
const refusal = <A, E extends { readonly _tag: string }>(
  env: Env,
  call: Effect.Effect<A, E, braintrust.BraintrustOpContext>,
) =>
  asHost(env, call).pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  );

/** ACLs reach Braintrust's read path a moment after they're created. */
const settled = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "NotFoundOrForbidden",
      schedule: Schedule.spaced("2 seconds"),
      times: 10,
    }),
  );

/** The grants on a host's service account, as `<object type>:<id>:<permission>`. */
const grantsOf = (env: Env) =>
  Effect.gen(function* () {
    const key = Redacted.value(keyOf(env));
    const tokens = yield* Stream.runCollect(braintrust.listServiceTokens.items({}));
    const token = Array.from(tokens).find((t) => t.preview_name.slice(-4) === key.slice(-4));
    expect(token?.service_account_id).toBeTypeOf("string");
    const acls = yield* Stream.runCollect(
      braintrust.listOrgAcls.items({ user_id: token!.service_account_id! }),
    );
    return {
      serviceAccountId: token!.service_account_id!,
      grants: Array.from(acls)
        .map(
          (acl) =>
            `${acl.object_type}:${acl.object_id}:${acl.permission}${acl.restrict_object_type ? `:${acl.restrict_object_type}` : ""}`,
        )
        .sort(),
    };
  });

let bound: Bound;
let deployed: {
  ids: {
    projectId: string;
    experimentId: string;
    datasetId: string;
    secretId: string;
    otherProjectId: string;
    otherExperimentId: string;
    otherDatasetId: string;
  };
  reader: Env;
  writer: Env;
  readWriter: Env;
  ops: Env;
};

describe("Braintrust bindings", { tags }, () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      deployed = yield* sharedStack.deploy(
        Effect.gen(function* () {
          bound = yield* Objects;
          const other = yield* Others;
          return {
            ids: {
              projectId: bound.project.projectId,
              experimentId: bound.experiment.experimentId,
              datasetId: bound.dataset.datasetId,
              secretId: bound.secret.aiSecretId,
              otherProjectId: other.project.projectId,
              otherExperimentId: other.experiment.experimentId,
              otherDatasetId: other.dataset.datasetId,
            },
            reader: yield* host("ReaderHost", readerInit(bound)),
            writer: yield* host("WriterHost", writerInit(bound)),
            readWriter: yield* host("ReadWriterHost", readWriterInit(bound)),
            ops: yield* host("OpsHost", opsInit(bound)),
          };
        }),
      );
    }),
    { timeout: 600_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 600_000 });

  describe("BraintrustBindings", () => {
    test.provider(
      "gives each host its own account and token, granted only on the objects it binds",
      (_stack) =>
        Effect.gen(function* () {
          const { ids, reader, writer, readWriter, ops } = deployed;
          const project = `project:${ids.projectId}`;
          const logs = `project_log:${ids.projectId}`;
          const experiment = `experiment:${ids.experimentId}`;
          const dataset = `dataset:${ids.datasetId}`;
          const secret = `ai_secret:${ids.secretId}`;

          const readerGrants = yield* grantsOf(reader);
          expect(readerGrants.grants).toEqual(
            [`${dataset}:read`, `${experiment}:read`, `${logs}:read`].sort(),
          );
          const writerGrants = yield* grantsOf(writer);
          expect(writerGrants.grants).toEqual(
            [`${dataset}:update`, `${experiment}:update`, `${logs}:update`].sort(),
          );
          const readWriterGrants = yield* grantsOf(readWriter);
          expect(readWriterGrants.grants).toEqual(
            [
              `${dataset}:read`,
              `${dataset}:update`,
              `${experiment}:read`,
              `${experiment}:update`,
              `${logs}:read`,
              `${logs}:update`,
            ].sort(),
          );
          // Bindings that need the same permission on the same object share one ACL.
          const opsGrants = yield* grantsOf(ops);
          expect(opsGrants.grants).toEqual(
            [
              `${dataset}:read`,
              `${dataset}:update`,
              `${experiment}:read`,
              `${experiment}:update`,
              `${logs}:read`,
              `${logs}:update`,
              `${project}:read`,
              `${project}:create:experiment`,
              `${secret}:read`,
            ].sort(),
          );
          const accounts = new Set(
            [readerGrants, writerGrants, readWriterGrants, opsGrants].map(
              (g) => g.serviceAccountId,
            ),
          );
          expect(accounts.size).toBe(4);
          expect(reader.BRAINTRUST_API_URL).toBe(Braintrust.DEFAULT_API_URL);
          expect(Redacted.isRedacted(reader.BRAINTRUST_API_KEY)).toBe(true);
        }),
      { tags, timeout: 120_000 },
    );
  });

  describe("ReadProjectLogs", () => {
    test(
      "fetches the project's logs, and is refused another project's and every write",
      Effect.gen(function* () {
        const { ids, reader } = deployed;
        const page = yield* inHost(reader, readerInit(bound), ({ logs }) =>
          settled(logs.fetch({ limit: 10 })),
        );
        expect(page.events).toEqual([]);
        expect(
          yield* refusal(
            reader,
            braintrust.fetchProjectLogEvents({ project_id: ids.otherProjectId }),
          ),
        ).toBe("NotFoundOrForbidden");
        expect(
          yield* refusal(
            reader,
            braintrust.insertProjectLogEvents({
              project_id: ids.projectId,
              events: [{ input: "x" }],
            }),
          ),
        ).toBe("NotFoundOrForbidden");
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("ReadExperiment", () => {
    test(
      "fetches and summarizes the experiment, and is refused another experiment",
      Effect.gen(function* () {
        const { ids, reader } = deployed;
        const { page, summary } = yield* inHost(reader, readerInit(bound), ({ experiment }) =>
          Effect.all({
            page: settled(experiment.fetch()),
            summary: settled(experiment.summarize({ summarize_scores: true })),
          }),
        );
        expect(page.events).toEqual([]);
        expect(summary.experiment_url).toContain("/experiments/");
        expect(
          yield* refusal(
            reader,
            braintrust.fetchExperimentEvents({ experiment_id: ids.otherExperimentId }),
          ),
        ).toBe("NotFoundOrForbidden");
        expect(
          yield* refusal(
            reader,
            braintrust.insertExperimentEvents({
              experiment_id: ids.experimentId,
              events: [{ input: "x" }],
            }),
          ),
        ).toBe("NotFoundOrForbidden");
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("ReadDataset", () => {
    test(
      "fetches, summarizes and previews a restore of the dataset, and is refused another dataset and a restore",
      Effect.gen(function* () {
        const { ids, reader } = deployed;
        const result = yield* inHost(reader, readerInit(bound), ({ dataset }) =>
          Effect.all({
            page: settled(dataset.fetch({ limit: 10 })),
            summary: settled(dataset.summarize({ summarize_data: true })),
            preview: settled(dataset.previewRestore({ version: "1000192345678901" })),
          }),
        );
        expect(result.page.events).toEqual([]);
        expect(result.summary.data_summary?.total_records).toBe(0);
        expect(result.preview).toEqual({ rows_to_restore: 0, rows_to_delete: 0 });
        expect(
          yield* refusal(reader, braintrust.fetchDatasetEvents({ dataset_id: ids.otherDatasetId })),
        ).toBe("NotFoundOrForbidden");
        expect(
          yield* refusal(
            reader,
            braintrust.restoreDataset({ dataset_id: ids.datasetId, version: "1000192345678901" }),
          ),
        ).toBe("NotFoundOrForbidden");
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("WriteDataset", () => {
    test(
      "restores the dataset, and is refused reads",
      Effect.gen(function* () {
        const { ids, writer } = deployed;
        const restored = yield* inHost(writer, writerInit(bound), ({ dataset }) =>
          settled(dataset.restore({ version: "1000192345678901" })),
        );
        expect(restored.rows_restored).toBe(0);
        expect(
          yield* refusal(writer, braintrust.fetchDatasetEvents({ dataset_id: ids.datasetId })),
        ).toBe("NotFoundOrForbidden");
      }),
      { tags, timeout: 120_000 },
    );

    // Blocked while the organization has no log credits (402 PaymentRequired).
    test(
      "adds records and feedback",
      Effect.gen(function* () {
        const { writer } = deployed;
        const { inserted, feedback } = yield* inHost(writer, writerInit(bound), ({ dataset }) =>
          Effect.gen(function* () {
            const inserted = yield* settled(
              dataset.insert({ events: [{ id: "write-dataset", input: "q", expected: "a" }] }),
            );
            const feedback = yield* dataset.feedback({
              feedback: [{ id: "write-dataset", comment: "checked" }],
            });
            return { inserted, feedback };
          }),
        );
        expect(inserted.row_ids).toEqual(["write-dataset"]);
        expect(feedback.status).toBe("success");
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("WriteProjectLogs", () => {
    test(
      "is refused reads",
      Effect.gen(function* () {
        const { ids, writer } = deployed;
        expect(
          yield* refusal(writer, braintrust.fetchProjectLogEvents({ project_id: ids.projectId })),
        ).toBe("NotFoundOrForbidden");
      }),
      { tags, timeout: 120_000 },
    );

    // Blocked while the organization has no log credits (402 PaymentRequired).
    test(
      "logs events and feedback",
      Effect.gen(function* () {
        const { writer } = deployed;
        const { inserted, feedback } = yield* inHost(writer, writerInit(bound), ({ logs }) =>
          Effect.gen(function* () {
            const inserted = yield* settled(
              logs.insert({ events: [{ id: "write-logs", input: "q", output: "a" }] }),
            );
            const feedback = yield* logs.feedback({
              feedback: [{ id: "write-logs", scores: { helpful: 1 } }],
            });
            return { inserted, feedback };
          }),
        );
        expect(inserted.row_ids).toEqual(["write-logs"]);
        expect(feedback.status).toBe("success");
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("WriteExperiment", () => {
    test(
      "is refused reads",
      Effect.gen(function* () {
        const { ids, writer } = deployed;
        expect(
          yield* refusal(
            writer,
            braintrust.fetchExperimentEvents({ experiment_id: ids.experimentId }),
          ),
        ).toBe("NotFoundOrForbidden");
      }),
      { tags, timeout: 120_000 },
    );

    // Blocked while the organization has no log credits (402 PaymentRequired).
    test(
      "records results and feedback",
      Effect.gen(function* () {
        const { writer } = deployed;
        const { inserted, feedback } = yield* inHost(writer, writerInit(bound), ({ experiment }) =>
          Effect.gen(function* () {
            const inserted = yield* settled(
              experiment.insert({
                events: [{ id: "write-experiment", input: "q", output: "a", scores: { ok: 1 } }],
              }),
            );
            const feedback = yield* experiment.feedback({
              feedback: [{ id: "write-experiment", comment: "checked" }],
            });
            return { inserted, feedback };
          }),
        );
        expect(inserted.row_ids).toEqual(["write-experiment"]);
        expect(feedback.status).toBe("success");
      }),
      { tags, timeout: 120_000 },
    );
  });

  // Blocked while the organization has no log credits (402 PaymentRequired):
  // each round trip writes before it reads.
  describe("ReadWriteProjectLogs", () => {
    test(
      "reads back what it logs",
      Effect.gen(function* () {
        const events = yield* inHost(deployed.readWriter, readWriterInit(bound), ({ logs }) =>
          Effect.gen(function* () {
            yield* settled(logs.insert({ events: [{ id: "rw-logs", input: "q", output: "a" }] }));
            return (yield* logs.fetch()).events;
          }),
        );
        expect(events.map((event) => event.id)).toContain("rw-logs");
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("ReadWriteExperiment", () => {
    test(
      "reads back what it records",
      Effect.gen(function* () {
        const events = yield* inHost(deployed.readWriter, readWriterInit(bound), ({ experiment }) =>
          Effect.gen(function* () {
            yield* settled(
              experiment.insert({ events: [{ id: "rw-experiment", input: "q", output: "a" }] }),
            );
            return (yield* experiment.fetch()).events;
          }),
        );
        expect(events.map((event) => event.id)).toContain("rw-experiment");
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("ReadWriteDataset", () => {
    test(
      "reads back what it adds",
      Effect.gen(function* () {
        const events = yield* inHost(deployed.readWriter, readWriterInit(bound), ({ dataset }) =>
          Effect.gen(function* () {
            yield* settled(
              dataset.insert({ events: [{ id: "rw-dataset", input: "q", expected: "a" }] }),
            );
            return (yield* dataset.fetch()).events;
          }),
        );
        expect(events.map((event) => event.id)).toContain("rw-dataset");
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("FetchProjectLogs", () => {
    test(
      "fetches the project's logs",
      Effect.gen(function* () {
        const page = yield* inHost(deployed.ops, opsInit(bound), ({ fetchLogs }) =>
          settled(fetchLogs({ limit: 10 })),
        );
        expect(page.events).toEqual([]);
      }),
      { tags, timeout: 120_000 },
    );
  });

  // Blocked while the organization has no log credits (402 PaymentRequired).
  describe("InsertProjectLogs", () => {
    test(
      "logs an event",
      Effect.gen(function* () {
        const inserted = yield* inHost(deployed.ops, opsInit(bound), ({ insertLogs }) =>
          settled(insertLogs({ events: [{ id: "insert-logs", input: "q", output: "a" }] })),
        );
        expect(inserted.row_ids).toEqual(["insert-logs"]);
      }),
      { tags, timeout: 120_000 },
    );
  });

  // Blocked while the organization has no log credits (402 PaymentRequired).
  describe("ProjectLogFeedback", () => {
    test(
      "scores a logged event",
      Effect.gen(function* () {
        const result = yield* inHost(deployed.ops, opsInit(bound), ({ insertLogs, logFeedback }) =>
          Effect.gen(function* () {
            yield* settled(insertLogs({ events: [{ id: "log-feedback", input: "q" }] }));
            return yield* logFeedback({ feedback: [{ id: "log-feedback", scores: { ok: 1 } }] });
          }),
        );
        expect(result.status).toBe("success");
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("FetchExperimentEvents", () => {
    test(
      "fetches the experiment's events",
      Effect.gen(function* () {
        const page = yield* inHost(deployed.ops, opsInit(bound), ({ fetchExperiment }) =>
          settled(fetchExperiment()),
        );
        expect(page.events).toEqual([]);
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("SummarizeExperiment", () => {
    test(
      "summarizes the experiment",
      Effect.gen(function* () {
        const summary = yield* inHost(deployed.ops, opsInit(bound), ({ summarizeExperiment }) =>
          settled(summarizeExperiment({ summarize_scores: true })),
        );
        expect(summary.experiment_url).toContain("/experiments/");
        expect(summary.scores ?? {}).toEqual({});
      }),
      { tags, timeout: 120_000 },
    );
  });

  // Blocked while the organization has no log credits (402 PaymentRequired).
  describe("InsertExperimentEvents", () => {
    test(
      "records a result",
      Effect.gen(function* () {
        const inserted = yield* inHost(deployed.ops, opsInit(bound), ({ insertExperiment }) =>
          settled(
            insertExperiment({ events: [{ id: "insert-experiment", input: "q", output: "a" }] }),
          ),
        );
        expect(inserted.row_ids).toEqual(["insert-experiment"]);
      }),
      { tags, timeout: 120_000 },
    );
  });

  // Blocked while the organization has no log credits (402 PaymentRequired).
  describe("ExperimentFeedback", () => {
    test(
      "comments on a recorded result",
      Effect.gen(function* () {
        const result = yield* inHost(
          deployed.ops,
          opsInit(bound),
          ({ insertExperiment, experimentFeedback }) =>
            Effect.gen(function* () {
              yield* settled(
                insertExperiment({ events: [{ id: "experiment-feedback", input: "q" }] }),
              );
              return yield* experimentFeedback({
                feedback: [{ id: "experiment-feedback", comment: "checked" }],
              });
            }),
        );
        expect(result.status).toBe("success");
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("FetchDatasetEvents", () => {
    test(
      "fetches the dataset's records",
      Effect.gen(function* () {
        const page = yield* inHost(deployed.ops, opsInit(bound), ({ fetchDataset }) =>
          settled(fetchDataset({ limit: 10 })),
        );
        expect(page.events).toEqual([]);
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("SummarizeDataset", () => {
    test(
      "counts the dataset's records",
      Effect.gen(function* () {
        const summary = yield* inHost(deployed.ops, opsInit(bound), ({ summarizeDataset }) =>
          settled(summarizeDataset({ summarize_data: true })),
        );
        expect(summary.data_summary?.total_records).toBe(0);
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("PreviewDatasetRestore", () => {
    test(
      "previews a restore of the dataset",
      Effect.gen(function* () {
        const preview = yield* inHost(deployed.ops, opsInit(bound), ({ previewRestore }) =>
          settled(previewRestore({ version: "1000192345678901" })),
        );
        expect(preview).toEqual({ rows_to_restore: 0, rows_to_delete: 0 });
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("RestoreDataset", () => {
    test(
      "restores the dataset to a version",
      Effect.gen(function* () {
        const restored = yield* inHost(deployed.ops, opsInit(bound), ({ restore }) =>
          settled(restore({ version: "1000192345678901" })),
        );
        expect(restored).toMatchObject({ rows_restored: 0, rows_deleted: 0 });
      }),
      { tags, timeout: 120_000 },
    );
  });

  // Blocked while the organization has no log credits (402 PaymentRequired).
  describe("InsertDatasetEvents", () => {
    test(
      "adds a record",
      Effect.gen(function* () {
        const inserted = yield* inHost(deployed.ops, opsInit(bound), ({ insertDataset }) =>
          settled(insertDataset({ events: [{ id: "insert-dataset", input: "q", expected: "a" }] })),
        );
        expect(inserted.row_ids).toEqual(["insert-dataset"]);
      }),
      { tags, timeout: 120_000 },
    );
  });

  // Blocked while the organization has no log credits (402 PaymentRequired).
  describe("DatasetFeedback", () => {
    test(
      "comments on a record",
      Effect.gen(function* () {
        const result = yield* inHost(
          deployed.ops,
          opsInit(bound),
          ({ insertDataset, datasetFeedback }) =>
            Effect.gen(function* () {
              yield* settled(insertDataset({ events: [{ id: "dataset-feedback", input: "q" }] }));
              return yield* datasetFeedback({
                feedback: [{ id: "dataset-feedback", comment: "checked" }],
              });
            }),
        );
        expect(result.status).toBe("success");
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("LaunchEval", () => {
    test(
      "runs an eval in the project and records it in a new experiment",
      Effect.gen(function* () {
        const { ids } = deployed;
        const summary = yield* inHost(deployed.ops, opsInit(bound), ({ launchEval }) =>
          settled(
            launchEval({
              data: { dataset_id: ids.datasetId },
              task: { global_function: "ExactMatch" },
              scores: [{ global_function: "ExactMatch" }],
            }),
          ),
        );
        expect(summary.project_url).toContain("/p/");
        expect(summary.experiment_url).toContain("/experiments/");
      }),
      { tags, timeout: 180_000 },
    );
  });

  // The bound secret's key is not a real OpenAI key, so a call that reaches
  // OpenAI comes back 401 with OpenAI's JSON body. Without the bound secret
  // the proxy answers 401 itself ("Braintrust gateway error: no provider
  // credentials available"), and a model no bound secret serves isn't found.
  const reachedOpenAi = <A, E extends { readonly _tag: string; readonly message?: string }>(
    call: (
      clients: Effect.Success<ReturnType<typeof opsInit>>,
    ) => Effect.Effect<A, E, RuntimeContext>,
  ) =>
    inHost(deployed.ops, opsInit(bound), (clients) =>
      call(clients).pipe(
        Effect.flip,
        Effect.map((error) => ({ tag: error._tag, message: String(error.message ?? "") })),
      ),
    );

  const expectReachedOpenAi = (reached: { tag: string; message: string }) => {
    expect(reached.tag).toBe("Unauthorized");
    expect(reached.message).not.toContain("Braintrust gateway error");
  };

  describe("ProxyChatCompletions", () => {
    test(
      "calls OpenAI with the bound secret's key, and no other provider",
      Effect.gen(function* () {
        const reached = yield* reachedOpenAi(({ chat }) =>
          chat({ model: "gpt-4.1-mini", messages: [{ role: "user", content: "hi" }] }),
        );
        expectReachedOpenAi(reached);
        const other = yield* reachedOpenAi(({ chat }) =>
          chat({ model: "claude-3-5-haiku-latest", messages: [{ role: "user", content: "hi" }] }),
        );
        expect(other.tag).toBe("NotFound");
        expect(other.message).toContain("No provider found");
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("ProxyCompletions", () => {
    test(
      "calls OpenAI with the bound secret's key",
      Effect.gen(function* () {
        const reached = yield* reachedOpenAi(({ complete }) =>
          complete({ model: "gpt-3.5-turbo-instruct", prompt: "hi" }),
        );
        expectReachedOpenAi(reached);
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("ProxyEmbeddings", () => {
    test(
      "calls OpenAI with the bound secret's key",
      Effect.gen(function* () {
        const reached = yield* reachedOpenAi(({ embed }) =>
          embed({ model: "text-embedding-3-small", input: "hi" }),
        );
        expectReachedOpenAi(reached);
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("ProxyAuto", () => {
    test(
      "calls OpenAI with the bound secret's key",
      Effect.gen(function* () {
        const reached = yield* reachedOpenAi(({ auto }) =>
          auto({ model: "gpt-4.1-nano", messages: [{ role: "user", content: "hi" }] }),
        );
        expectReachedOpenAi(reached);
      }),
      { tags, timeout: 120_000 },
    );
  });

  describe("ProxyRequest", () => {
    test(
      "sends any OpenAI path with the bound secret's key",
      Effect.gen(function* () {
        const reached = yield* reachedOpenAi(({ proxy }) =>
          proxy({ path: "responses", model: "gpt-4.1-mini", input: "hi" }),
        );
        expectReachedOpenAi(reached);
      }),
      { tags, timeout: 120_000 },
    );
  });
});

// Blocked while the organization has no log credits: creating the Function
// answers 402 PaymentRequired, so there is nothing to invoke.
describe("InvokeFunction", { tags }, () => {
  test.provider(
    "runs the bound function as the host",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const { env } = yield* stack.deploy(
          Effect.gen(function* () {
            const project = yield* Braintrust.Project("Invoked", {});
            const fn = yield* Braintrust.Function("Echo", {
              projectId: project.projectId,
              functionData: {
                type: "code",
                data: {
                  type: "inline",
                  runtime_context: { runtime: "node", version: "20" },
                  code: "async function handler({ input }) { return input; }",
                },
              },
            });
            invoked = fn;
            return { env: yield* host("InvokerHost", invokerInit(fn)) };
          }),
        );
        const output = yield* inHost(env, invokerInit(invoked), (invoke) =>
          settled(invoke({ input: { echo: "hi" } })),
        );
        expect(output).toEqual({ echo: "hi" });
        yield* stack.destroy();
      }),
    { tags, timeout: 300_000 },
  );
});

let invoked: Braintrust.Function;
