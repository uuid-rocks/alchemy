import * as Braintrust from "@alchemy.run/braintrust";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Drift from "alchemy/Drift";
import * as Namespace from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import { type BaseRuntimeContext, RuntimeContext } from "alchemy/RuntimeContext";
import { Self } from "alchemy/Self";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Scheduler from "effect/Scheduler";
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
  // Not a real Anthropic key either: a call that reaches Anthropic with it
  // proves the proxy used this secret.
  const secret = yield* Braintrust.AiSecret("OtherSecret", {
    type: "anthropic",
    secret: Redacted.make("sk-ant-fake-not-a-key"),
  });
  return { project, experiment, dataset, secret };
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

/**
 * The reader's bindings, registered concurrently with the scheduler yielding
 * after every operation, so they interleave wherever they can.
 */
const concurrentInit = (b: Bound) =>
  Effect.all(
    [
      Braintrust.ReadProjectLogs(b.project),
      Braintrust.ReadExperiment(b.experiment),
      Braintrust.ReadDataset(b.dataset),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Braintrust.ReadProjectLogsHttp,
        Braintrust.ReadExperimentHttp,
        Braintrust.ReadDatasetHttp,
      ),
    ),
    Effect.provideService(Scheduler.MaxOpsBeforeYield, 1),
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
 * `RuntimeContext`, as inside a deployed host. Setting `__ALCHEMY_RUNTIME__`
 * is seen by every test in the process, so a test that calls this runs
 * `exclusive`.
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

/** Fetches until row `id` shows up: a write takes a few seconds to be readable. */
const readBack = <P extends { readonly events: ReadonlyArray<{ readonly id: string }> }, E, R>(
  fetch: Effect.Effect<P, E, R>,
  id: string,
) =>
  fetch.pipe(
    Effect.repeat({
      until: (page) => page.events.some((event) => event.id === id),
      schedule: Schedule.spaced("6 seconds"),
      times: 10,
    }),
  );

/** Adds record `id` and returns the dataset version that includes it. */
const versionAfter = (
  id: string,
  insert: Braintrust.InsertDatasetEventsClient,
  fetch: Braintrust.FetchDatasetEventsClient,
) =>
  Effect.gen(function* () {
    yield* settled(insert({ events: [{ id, input: "q" }] }));
    const { events } = yield* readBack(fetch(), id);
    const record = events.find((event) => event.id === id);
    expect(record?._xact_id).toBeTypeOf("string");
    return record!._xact_id;
  });

/**
 * The grants on a host's service account, as `<object type>:<id>:<permission>`.
 * Only direct permissions: Braintrust adds an Owner role ACL on each
 * experiment a host launches.
 */
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
        .filter((acl) => acl.permission && !acl.role_id)
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
    experimentName: string;
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
  concurrent: Env;
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
              experimentName: bound.experiment.name,
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
            concurrent: yield* host("ConcurrentHost", concurrentInit(bound)),
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
              `${dataset}:delete`,
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

    test.provider(
      "grants every object bound concurrently on one host",
      (_stack) =>
        Effect.gen(function* () {
          const { ids, concurrent } = deployed;
          expect((yield* grantsOf(concurrent)).grants).toEqual(
            [
              `dataset:${ids.datasetId}:read`,
              `experiment:${ids.experimentId}:read`,
              `project_log:${ids.projectId}:read`,
            ].sort(),
          );
        }),
      { tags, timeout: 120_000 },
    );
  });

  describe("ReadProjectLogs", () => {
    test.provider(
      "fetches the project's logs, and is refused another project's and every write",
      (_stack) =>
        Effect.gen(function* () {
          const { ids, reader } = deployed;
          // The reader can't write, so the deployer logs the row it reads back.
          yield* braintrust.insertProjectLogEvents({
            project_id: ids.projectId,
            events: [{ id: "read-logs", input: "q" }],
          });
          const page = yield* inHost(reader, readerInit(bound), ({ logs }) =>
            Effect.andThen(settled(logs.fetch()), readBack(logs.fetch(), "read-logs")),
          );
          expect(page.events.map((event) => event.id)).toContain("read-logs");
          expect(page.events.every((event) => event.project_id === ids.projectId)).toBe(true);
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
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("ReadExperiment", () => {
    test.provider(
      "fetches and summarizes the experiment, and is refused another experiment",
      (_stack) =>
        Effect.gen(function* () {
          const { ids, reader } = deployed;
          yield* braintrust.insertExperimentEvents({
            experiment_id: ids.experimentId,
            events: [{ id: "read-experiment", input: "q" }],
          });
          const { page, summary } = yield* inHost(reader, readerInit(bound), ({ experiment }) =>
            Effect.all({
              page: Effect.andThen(
                settled(experiment.fetch()),
                readBack(experiment.fetch(), "read-experiment"),
              ),
              summary: settled(experiment.summarize({ summarize_scores: true })),
            }),
          );
          expect(page.events.map((event) => event.id)).toContain("read-experiment");
          expect(page.events.every((event) => event.experiment_id === ids.experimentId)).toBe(true);
          expect(summary.experiment_name).toBe(ids.experimentName);
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
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("ReadDataset", () => {
    test.provider(
      "fetches, summarizes and previews a restore of the dataset, and is refused another dataset and a restore",
      (_stack) =>
        Effect.gen(function* () {
          const { ids, reader } = deployed;
          yield* braintrust.insertDatasetEvents({
            dataset_id: ids.datasetId,
            events: [{ id: "read-dataset", input: "q" }],
          });
          const result = yield* inHost(reader, readerInit(bound), ({ dataset }) =>
            Effect.gen(function* () {
              const page = yield* Effect.andThen(
                settled(dataset.fetch()),
                readBack(dataset.fetch(), "read-dataset"),
              );
              // The summary counts a new record a moment after a fetch returns it.
              const summary = yield* dataset.summarize({ summarize_data: true }).pipe(
                Effect.repeat({
                  until: (s) => s.data_summary?.total_records === page.events.length,
                  schedule: Schedule.spaced("2 seconds"),
                  times: 10,
                }),
              );
              return { page, summary };
            }),
          );
          // Restoring the dataset to its current version changes nothing.
          const current = result.page.events
            .map((event) => event._xact_id)
            .sort()
            .at(-1);
          const preview = yield* inHost(reader, readerInit(bound), ({ dataset }) =>
            dataset.previewRestore({ version: current ?? "0" }),
          );
          expect(result.page.events.map((event) => event.id)).toContain("read-dataset");
          expect(result.page.events.every((event) => event.dataset_id === ids.datasetId)).toBe(
            true,
          );
          expect(result.summary.data_summary?.total_records).toBe(result.page.events.length);
          expect(preview).toEqual({ rows_to_restore: 0, rows_to_delete: 0 });
          expect(
            yield* refusal(
              reader,
              braintrust.fetchDatasetEvents({ dataset_id: ids.otherDatasetId }),
            ),
          ).toBe("NotFoundOrForbidden");
          expect(
            yield* refusal(
              reader,
              braintrust.restoreDataset({ dataset_id: ids.datasetId, version: "1000192345678901" }),
            ),
          ).toBe("NotFoundOrForbidden");
        }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("WriteDataset", () => {
    test(
      "is refused reads",
      Effect.gen(function* () {
        const { ids, writer } = deployed;
        // A write that lands first shows the token works, so the refusal is the missing grant.
        yield* inHost(writer, writerInit(bound), ({ dataset }) =>
          settled(dataset.insert({ events: [{ id: "refused-read", input: "q" }] })),
        );
        expect(
          yield* refusal(writer, braintrust.fetchDatasetEvents({ dataset_id: ids.datasetId })),
        ).toBe("NotFoundOrForbidden");
      }),
      { tags, timeout: 120_000, exclusive: true },
    );

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
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("WriteProjectLogs", () => {
    test(
      "is refused reads",
      Effect.gen(function* () {
        const { ids, writer } = deployed;
        // A write that lands first shows the token works, so the refusal is the missing grant.
        yield* inHost(writer, writerInit(bound), ({ logs }) =>
          settled(logs.insert({ events: [{ id: "refused-read", input: "q" }] })),
        );
        expect(
          yield* refusal(writer, braintrust.fetchProjectLogEvents({ project_id: ids.projectId })),
        ).toBe("NotFoundOrForbidden");
      }),
      { tags, timeout: 120_000, exclusive: true },
    );

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
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("WriteExperiment", () => {
    test(
      "is refused reads",
      Effect.gen(function* () {
        const { ids, writer } = deployed;
        // A write that lands first shows the token works, so the refusal is the missing grant.
        yield* inHost(writer, writerInit(bound), ({ experiment }) =>
          settled(experiment.insert({ events: [{ id: "refused-read", input: "q" }] })),
        );
        expect(
          yield* refusal(
            writer,
            braintrust.fetchExperimentEvents({ experiment_id: ids.experimentId }),
          ),
        ).toBe("NotFoundOrForbidden");
      }),
      { tags, timeout: 120_000, exclusive: true },
    );

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
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("ReadWriteProjectLogs", () => {
    test(
      "reads back what it logs",
      Effect.gen(function* () {
        const events = yield* inHost(deployed.readWriter, readWriterInit(bound), ({ logs }) =>
          Effect.gen(function* () {
            yield* settled(logs.insert({ events: [{ id: "rw-logs", input: "q", output: "a" }] }));
            return (yield* readBack(logs.fetch(), "rw-logs")).events;
          }),
        );
        expect(events.map((event) => event.id)).toContain("rw-logs");
      }),
      { tags, timeout: 120_000, exclusive: true },
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
            return (yield* readBack(experiment.fetch(), "rw-experiment")).events;
          }),
        );
        expect(events.map((event) => event.id)).toContain("rw-experiment");
      }),
      { tags, timeout: 120_000, exclusive: true },
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
            return (yield* readBack(dataset.fetch(), "rw-dataset")).events;
          }),
        );
        expect(events.map((event) => event.id)).toContain("rw-dataset");
      }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("FetchProjectLogs", () => {
    test(
      "fetches the project's logs",
      Effect.gen(function* () {
        const page = yield* inHost(deployed.ops, opsInit(bound), ({ insertLogs, fetchLogs }) =>
          Effect.gen(function* () {
            yield* settled(insertLogs({ events: [{ id: "fetch-logs", input: "q" }] }));
            return yield* readBack(fetchLogs(), "fetch-logs");
          }),
        );
        expect(page.events.map((event) => event.id)).toContain("fetch-logs");
        expect(page.events.every((event) => event.project_id === deployed.ids.projectId)).toBe(
          true,
        );
      }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("InsertProjectLogs", () => {
    test(
      "logs an event",
      Effect.gen(function* () {
        const inserted = yield* inHost(deployed.ops, opsInit(bound), ({ insertLogs }) =>
          settled(insertLogs({ events: [{ id: "insert-logs", input: "q", output: "a" }] })),
        );
        expect(inserted.row_ids).toEqual(["insert-logs"]);
      }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });

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
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("FetchExperimentEvents", () => {
    test(
      "fetches the experiment's events",
      Effect.gen(function* () {
        const page = yield* inHost(
          deployed.ops,
          opsInit(bound),
          ({ insertExperiment, fetchExperiment }) =>
            Effect.gen(function* () {
              yield* settled(
                insertExperiment({ events: [{ id: "fetch-experiment", input: "q" }] }),
              );
              return yield* readBack(fetchExperiment(), "fetch-experiment");
            }),
        );
        expect(page.events.map((event) => event.id)).toContain("fetch-experiment");
        expect(
          page.events.every((event) => event.experiment_id === deployed.ids.experimentId),
        ).toBe(true);
      }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("SummarizeExperiment", () => {
    test(
      "summarizes the experiment",
      Effect.gen(function* () {
        const summary = yield* inHost(deployed.ops, opsInit(bound), ({ summarizeExperiment }) =>
          settled(summarizeExperiment({ summarize_scores: true })),
        );
        expect(summary.experiment_name).toBe(deployed.ids.experimentName);
        expect(summary.experiment_url).toContain("/experiments/");
      }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });

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
      { tags, timeout: 120_000, exclusive: true },
    );
  });

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
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("FetchDatasetEvents", () => {
    test(
      "fetches the dataset's records",
      Effect.gen(function* () {
        const page = yield* inHost(
          deployed.ops,
          opsInit(bound),
          ({ insertDataset, fetchDataset }) =>
            Effect.gen(function* () {
              yield* settled(insertDataset({ events: [{ id: "fetch-dataset", input: "q" }] }));
              return yield* readBack(fetchDataset(), "fetch-dataset");
            }),
        );
        expect(page.events.map((event) => event.id)).toContain("fetch-dataset");
        expect(page.events.every((event) => event.dataset_id === deployed.ids.datasetId)).toBe(
          true,
        );
      }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("SummarizeDataset", () => {
    test(
      "counts the dataset's records",
      Effect.gen(function* () {
        const { page, summary } = yield* inHost(
          deployed.ops,
          opsInit(bound),
          ({ insertDataset, fetchDataset, summarizeDataset }) =>
            Effect.gen(function* () {
              yield* settled(insertDataset({ events: [{ id: "summarize-dataset", input: "q" }] }));
              const page = yield* readBack(fetchDataset(), "summarize-dataset");
              const summary = yield* summarizeDataset({ summarize_data: true }).pipe(
                Effect.repeat({
                  until: (s) => s.data_summary?.total_records === page.events.length,
                  schedule: Schedule.spaced("2 seconds"),
                  times: 10,
                }),
              );
              return { page, summary };
            }),
        );
        expect(page.events.map((event) => event.id)).toContain("summarize-dataset");
        expect(summary.data_summary?.total_records).toBe(page.events.length);
      }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("PreviewDatasetRestore", () => {
    test(
      "previews restoring the dataset to an earlier version",
      Effect.gen(function* () {
        const preview = yield* inHost(
          deployed.ops,
          opsInit(bound),
          ({ insertDataset, fetchDataset, previewRestore }) =>
            Effect.gen(function* () {
              const version = yield* versionAfter("preview-kept", insertDataset, fetchDataset);
              yield* insertDataset({ events: [{ id: "preview-dropped", input: "q" }] });
              return yield* previewRestore({ version });
            }),
        );
        expect(preview).toEqual({ rows_to_restore: 0, rows_to_delete: 1 });
      }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("RestoreDataset", () => {
    test(
      "restores the dataset to an earlier version",
      Effect.gen(function* () {
        const { restored, after } = yield* inHost(
          deployed.ops,
          opsInit(bound),
          ({ insertDataset, fetchDataset, restore }) =>
            Effect.gen(function* () {
              const version = yield* versionAfter("restore-kept", insertDataset, fetchDataset);
              yield* insertDataset({ events: [{ id: "restore-dropped", input: "q" }] });
              // A restore right after an insert misses it for a while (preview
              // doesn't); restoring the same version again is a no-op once done.
              const restored = yield* restore({ version }).pipe(
                Effect.repeat({
                  until: (result) => result.rows_deleted > 0,
                  schedule: Schedule.spaced("5 seconds"),
                  times: 10,
                }),
              );
              return { restored, after: yield* fetchDataset() };
            }),
        );
        expect(restored).toMatchObject({ rows_restored: 0, rows_deleted: 1 });
        const ids = after.events.map((event) => event.id);
        expect(ids).toContain("restore-kept");
        expect(ids).not.toContain("restore-dropped");
      }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("InsertDatasetEvents", () => {
    test(
      "adds a record",
      Effect.gen(function* () {
        const inserted = yield* inHost(deployed.ops, opsInit(bound), ({ insertDataset }) =>
          settled(insertDataset({ events: [{ id: "insert-dataset", input: "q", expected: "a" }] })),
        );
        expect(inserted.row_ids).toEqual(["insert-dataset"]);
      }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });

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
      { tags, timeout: 120_000, exclusive: true },
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
        expect(summary.projectId).toBe(ids.projectId);
        expect(summary.projectUrl).toContain("/p/");
        expect(summary.experimentUrl).toContain("/experiments/");
      }),
      { tags, timeout: 180_000, exclusive: true },
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

  const expectReachedProvider = (reached: { tag: string; message: string }) => {
    expect(reached.tag).toBe("Unauthorized");
    expect(reached.message).not.toContain("Braintrust gateway error");
  };

  describe("ProxyChatCompletions", () => {
    test.provider(
      "calls OpenAI with the bound secret's key, and can't use a secret the host isn't granted",
      (_stack) =>
        Effect.gen(function* () {
          const reached = yield* reachedOpenAi(({ chat }) =>
            chat({ model: "gpt-4.1-mini", messages: [{ role: "user", content: "hi" }] }),
          );
          expectReachedProvider(reached);
          // The org's Anthropic secret works for the deployer, who can read it...
          const claude = {
            model: "claude-haiku-4-5",
            messages: [{ role: "user", content: "hi" }],
          };
          const deployer = yield* braintrust.createProxyChatCompletion(claude).pipe(
            Effect.flip,
            Effect.map((error) => ({ tag: error._tag, message: String(error.message ?? "") })),
          );
          expectReachedProvider(deployer);
          // ...but not for the host, whose token can read only the bound secret.
          const other = yield* reachedOpenAi(({ chat }) => chat(claude));
          expect(other.tag).toBe("NotFound");
          expect(other.message).toContain("No provider found");
        }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("ProxyCompletions", () => {
    test(
      "calls OpenAI with the bound secret's key",
      Effect.gen(function* () {
        const reached = yield* reachedOpenAi(({ complete }) =>
          complete({ model: "gpt-3.5-turbo-instruct", prompt: "hi" }),
        );
        expectReachedProvider(reached);
      }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("ProxyEmbeddings", () => {
    test(
      "calls OpenAI with the bound secret's key",
      Effect.gen(function* () {
        const reached = yield* reachedOpenAi(({ embed }) =>
          embed({ model: "text-embedding-3-small", input: "hi" }),
        );
        expectReachedProvider(reached);
      }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("ProxyAuto", () => {
    test(
      "calls OpenAI with the bound secret's key",
      Effect.gen(function* () {
        const reached = yield* reachedOpenAi(({ auto }) =>
          auto({ model: "gpt-4.1-nano", messages: [{ role: "user", content: "hi" }] }),
        );
        expectReachedProvider(reached);
      }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });

  describe("ProxyRequest", () => {
    test(
      "sends any OpenAI path with the bound secret's key",
      Effect.gen(function* () {
        const reached = yield* reachedOpenAi(({ proxy }) =>
          proxy({ path: "responses", model: "gpt-4.1-mini", input: "hi" }),
        );
        expectReachedProvider(reached);
      }),
      { tags, timeout: 120_000, exclusive: true },
    );
  });
});

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
                  code: "async function handler(input) { return input; }",
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
    { tags, timeout: 300_000, exclusive: true },
  );
});

let invoked: Braintrust.Function;

describe("Host lifecycle", { tags }, () => {
  test.provider(
    "an unchanged redeploy keeps a host's account, token and grants, drift repair restores a deleted grant, a changed binding revokes what it no longer needs, and removing the host removes them",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const project = Braintrust.Project("Redeployed", {});
        // Bindings register in no fixed order across deploys, so `flipped`
        // binds the same two in the other order.
        const program = (flipped: boolean) =>
          Effect.gen(function* () {
            const bound = yield* project;
            const insert = Braintrust.InsertProjectLogs(bound);
            const read = Braintrust.ReadProjectLogs(bound);
            const env = yield* host(
              "RedeployHost",
              Effect.all(flipped ? [read, insert] : [insert, read]).pipe(
                Effect.provide(
                  Layer.mergeAll(Braintrust.InsertProjectLogsHttp, Braintrust.ReadProjectLogsHttp),
                ),
              ),
            );
            return { projectId: bound.projectId, env };
          });

        const first = yield* stack.deploy(program(false));
        const before = yield* grantsOf(first.env);
        expect(before.grants).toEqual([
          `project_log:${first.projectId}:read`,
          `project_log:${first.projectId}:update`,
        ]);

        for (const flipped of [false, true]) {
          const plan = yield* stack.plan(program(flipped));
          expect(
            Object.entries(plan.resources)
              .filter(([, node]) => node?.action !== "noop")
              .map(([fqn, node]) => `${fqn}: ${node?.action}`),
          ).toEqual([]);
        }

        const second = yield* stack.deploy(program(false));
        expect(yield* grantsOf(second.env)).toEqual(before);
        expect(Redacted.value(keyOf(second.env)) === Redacted.value(keyOf(first.env))).toBe(true);

        const owned = Effect.all({
          acls: Stream.runCollect(
            braintrust.listAcls.items({ object_type: "project_log", object_id: first.projectId }),
          ).pipe(
            Effect.map((acls) => acls.filter((acl) => acl.user_id === before.serviceAccountId)),
          ),
          tokens: Stream.runCollect(braintrust.listServiceTokens.items({})).pipe(
            Effect.map((tokens) =>
              tokens.filter((token) => token.service_account_id === before.serviceAccountId),
            ),
          ),
        });
        const deployed = yield* owned;
        expect([deployed.acls.length, deployed.tokens.length]).toEqual([2, 1]);

        // A grant deleted outside Alchemy is drift, and repairing it restores the grant.
        const detect = Drift.detect(stack).pipe(Effect.provide(stack.state));
        const grantsFqn = (resources: Record<string, unknown>) =>
          Object.keys(resources).find((fqn) => fqn.endsWith("BraintrustGrants"))!;
        const clean = yield* detect;
        const fqn = grantsFqn(clean.resources);
        expect(clean.resources[fqn]?.action).toBe("unchanged");
        const update = deployed.acls.find((acl) => acl.permission === "update");
        yield* braintrust.deleteAcl({ acl_id: update!.id });
        const drifted = yield* detect.pipe(
          Effect.repeat({
            until: (result) => result.resources[fqn]?.action === "drifted",
            schedule: Schedule.spaced("1 second"),
            times: 10,
          }),
        );
        expect(drifted.resources[fqn]?.action).toBe("drifted");
        const repaired = yield* Drift.repair(stack, { only: [fqn] }).pipe(
          Effect.provide(stack.state),
        );
        expect(repaired.resources[fqn]?.action).toBe("repaired");
        const restored = yield* grantsOf(second.env).pipe(
          Effect.repeat({
            until: ({ grants }) => grants.length === before.grants.length,
            schedule: Schedule.spaced("1 second"),
            times: 10,
          }),
        );
        expect(restored).toEqual(before);

        // Dropping a binding revokes the grant only it needed, on the same account.
        const swapped = yield* stack.deploy(
          Effect.gen(function* () {
            const bound = yield* project;
            return yield* host(
              "RedeployHost",
              Braintrust.ReadProjectLogs(bound).pipe(
                Effect.provide(Braintrust.ReadProjectLogsHttp),
              ),
            );
          }),
        );
        expect(yield* grantsOf(swapped)).toEqual({
          serviceAccountId: before.serviceAccountId,
          grants: [`project_log:${first.projectId}:read`],
        });

        // The project stays, so an empty ACL list on it means the grant was deleted.
        yield* stack.deploy(project);
        const leftover = yield* owned.pipe(
          Effect.repeat({
            until: ({ acls, tokens }) => acls.length === 0 && tokens.length === 0,
            schedule: Schedule.spaced("1 second"),
            times: 10,
          }),
        );
        expect(leftover.acls.length).toBe(0);
        expect(leftover.tokens.length).toBe(0);
        yield* stack.destroy();
      }),
    { tags, timeout: 300_000 },
  );
});

describe("Partial failure", { tags }, () => {
  test.provider(
    "a deploy whose grant fails keeps the host's account, and the next deploy revokes the grant it left",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const objects = Effect.gen(function* () {
          const project = yield* Braintrust.Project("Partial", {});
          const kept = yield* Braintrust.Dataset("Kept", { projectId: project.projectId });
          const gone = yield* Braintrust.Dataset("Gone", { projectId: project.projectId });
          return { project, kept, gone };
        });
        // The logs grant exists before the failing deploy, whatever order
        // that deploy would create grants in.
        const ids = yield* stack.deploy(
          Effect.gen(function* () {
            const all = yield* objects;
            yield* host(
              "PartialHost",
              Braintrust.ReadProjectLogs(all.project).pipe(
                Effect.provide(Braintrust.ReadProjectLogsHttp),
              ),
            );
            return all;
          }),
        );
        // Deleted behind the stack's back: the stack still binds its id, and
        // Braintrust refuses an ACL on it, before the logs grant it no longer
        // asks for is revoked.
        yield* braintrust.deleteDataset({ dataset_id: ids.gone.datasetId });

        const failure = yield* stack
          .deploy(
            Effect.gen(function* () {
              const { gone } = yield* objects;
              return yield* host(
                "PartialHost",
                Braintrust.ReadDataset(gone).pipe(Effect.provide(Braintrust.ReadDatasetHttp)),
              );
            }),
          )
          .pipe(Effect.flip);
        expect(String(failure)).toContain(ids.gone.datasetId);

        const program = Effect.gen(function* () {
          const { kept } = yield* objects;
          return yield* host(
            "PartialHost",
            Braintrust.ReadDataset(kept).pipe(Effect.provide(Braintrust.ReadDatasetHttp)),
          );
        });
        const plan = yield* stack.plan(program);
        const account = Object.values(plan.resources).find(
          (node) => node.resource.Type === "Braintrust.ServiceAccount",
        );
        const serviceAccountId: unknown = account?.state?.attr?.serviceAccountId;
        expect(serviceAccountId).toBeTypeOf("string");
        const logsAcls = yield* Stream.runCollect(
          braintrust.listAcls.items({
            object_type: "project_log",
            object_id: ids.project.projectId,
          }),
        );
        expect(logsAcls.filter((acl) => acl.user_id === serviceAccountId).length).toBe(1);

        // Fixed: the same account, and the logs grant no binding asks for is gone.
        const env = yield* stack.deploy(program);
        expect(yield* grantsOf(env)).toEqual({
          serviceAccountId,
          grants: [`dataset:${ids.kept.datasetId}:read`],
        });
        yield* stack.destroy();
      }),
    { tags, timeout: 300_000 },
  );
});

describe("Looked-up objects", { tags }, () => {
  test.provider(
    "grants a host each looked-up dataset it binds",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const project = yield* stack.deploy(Braintrust.Project("LookupProject", {}));
        // Datasets this stack doesn't manage, so `lookup` may find them. The
        // names differ only in punctuation, which must not merge their ACLs.
        const datasets = yield* Effect.forEach(["lookup-a", "lookup_a"], (name) =>
          braintrust.createDataset({ project_id: project.projectId, name }),
        );
        const env = yield* stack.deploy(
          Effect.gen(function* () {
            const project = yield* Braintrust.Project("LookupProject", {});
            const lookup = (name: string) =>
              Braintrust.Dataset.lookup({ projectId: project.projectId, name });
            return yield* host(
              "LookupHost",
              Effect.gen(function* () {
                yield* Braintrust.ReadDataset(lookup("lookup-a"));
                yield* Braintrust.ReadDataset(lookup("lookup_a"));
              }).pipe(Effect.provide(Braintrust.ReadDatasetHttp)),
            );
          }),
        );
        const { grants } = yield* grantsOf(env);
        expect(grants).toEqual(datasets.map((dataset) => `dataset:${dataset.id}:read`).sort());
        yield* stack.destroy();
      }),
    { tags, timeout: 300_000 },
  );

  test.provider(
    "grants a host same-named datasets looked up in two projects",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        // Both projects have the logical id `Project`, so only their FQNs differ.
        const projects = Effect.all(
          ["A", "B"].map((namespace) =>
            Braintrust.Project("Project", {}).pipe(Namespace.push(namespace)),
          ),
        );
        const deployed = yield* stack.deploy(projects);
        const datasets = yield* Effect.forEach(deployed, (project) =>
          braintrust.createDataset({ project_id: project.projectId, name: "lookup-same" }),
        );
        const env = yield* stack.deploy(
          Effect.gen(function* () {
            const bound = yield* projects;
            return yield* host(
              "LookupHost",
              Effect.forEach(bound, (project) =>
                Braintrust.ReadDataset(
                  Braintrust.Dataset.lookup({ projectId: project.projectId, name: "lookup-same" }),
                ),
              ).pipe(Effect.provide(Braintrust.ReadDatasetHttp)),
            );
          }),
        );
        const { grants } = yield* grantsOf(env);
        expect(grants).toEqual(datasets.map((dataset) => `dataset:${dataset.id}:read`).sort());
        yield* stack.destroy();
      }),
    { tags, timeout: 300_000 },
  );

  test.provider(
    "grants a host datasets looked up through closures that differ only in what they capture",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const projects = Effect.all({
          A: Braintrust.Project("ClosureA", {}),
          B: Braintrust.Project("ClosureB", {}),
        });
        const deployed = yield* stack.deploy(projects);
        const datasets = yield* Effect.forEach([deployed.A, deployed.B], (project) =>
          braintrust.createDataset({ project_id: project.projectId, name: "lookup-same" }),
        );
        const env = yield* stack.deploy(
          Effect.gen(function* () {
            const { A, B } = yield* projects;
            const ids = Output.map(Output.all(A.projectId, B.projectId), ([a, b]) => ({
              A: a,
              B: b,
            }));
            return yield* host(
              "LookupHost",
              Effect.forEach(["A", "B"] as const, (key) =>
                Braintrust.ReadDataset(
                  Braintrust.Dataset.lookup({
                    projectId: Output.map(ids, (byKey) => byKey[key]),
                    name: "lookup-same",
                  }),
                ),
              ).pipe(Effect.provide(Braintrust.ReadDatasetHttp)),
            );
          }),
        );
        const { grants } = yield* grantsOf(env);
        expect(grants).toEqual(datasets.map((dataset) => `dataset:${dataset.id}:read`).sort());
        yield* stack.destroy();
      }),
    { tags, timeout: 300_000 },
  );
});
