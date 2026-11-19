import * as Braintrust from "@alchemy.run/braintrust";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import BraintrustWorker, { Dataset, Echo, Experiment } from "./fixtures/worker.ts";

const testOptions = { providers: Layer.mergeAll(Braintrust.providers(), Cloudflare.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BraintrustExternalHost", import.meta.url);

type Body = { ok: boolean; result?: any; error?: string };

let url: string;
let datasetId: string;
let experimentName: string;

// New ACLs and fresh writes take a while to show: retry until the route
// answers `ok` with a result `until` accepts, then report the last answer so a
// real failure shows Braintrust's error.
const call = (route: string, until: (result: any) => boolean = () => true) =>
  HttpClient.get(`${url}${route}`).pipe(
    Effect.timeout("15 seconds"),
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as Body),
    Effect.flatMap((body) =>
      body?.ok && until(body.result) ? Effect.succeed(body) : Effect.fail(body),
    ),
    Effect.retry({ schedule: Schedule.spaced("6 seconds"), times: 10 }),
    Effect.catch((body) => Effect.succeed(body as Body)),
  );

const hasEvent = (id: string) => (page: { events: { id: string }[] }) =>
  page.events.some((event) => event.id === id);

// The bound OpenAI key is fake, so OpenAI's own 401 proves the proxy used it;
// without it the proxy answers 401 itself with "Braintrust gateway error".
const reachedOpenAi = (result: { tag: string; message: string }) =>
  result.tag === "Unauthorized" && !result.message.includes("Braintrust gateway error");

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

describe(
  "Braintrust bindings on a Cloudflare Worker",
  { tags: ["provider:braintrust", "provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const worker = yield* BraintrustWorker;
            const experiment = yield* Experiment;
            yield* Echo;
            const dataset = yield* Dataset;
            return {
              url: worker.url.as<string>(),
              datasetId: dataset.datasetId,
              experimentName: experiment.name,
            };
          }),
        );
        url = out.url;
        datasetId = out.datasetId;
        experimentName = out.experimentName;
        // A fresh workers.dev URL takes a while to answer; wait here so each
        // test's retries cover only Braintrust's own propagation.
        yield* HttpClient.get(url).pipe(
          Effect.flatMap((response) =>
            response.status === 200 ? Effect.void : Effect.fail(response.status),
          ),
          Effect.retry({ schedule: Schedule.spaced("6 seconds"), times: 10 }),
        );
      }),
      { timeout: 600_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    test(
      "ReadWriteProjectLogs fetches the project's logs",
      Effect.gen(function* () {
        expectOk(yield* call("/logs/insert"));
        const body = yield* call("/logs", hasEvent("worker-log"));
        expectOk(body);
        expect(hasEvent("worker-log")(body.result)).toBe(true);
      }),
      { timeout: 240_000 },
    );

    test(
      "ReadWriteProjectLogs logs an event",
      Effect.gen(function* () {
        const body = yield* call("/logs/insert");
        expectOk(body);
        expect(body.result.row_ids).toEqual(["worker-log"]);
      }),
      { timeout: 240_000 },
    );

    test(
      "ReadExperiment fetches and summarizes the experiment",
      Effect.gen(function* () {
        expectOk(yield* call("/experiment/write"));
        const body = yield* call("/experiment", (result) => hasEvent("worker-result")(result.page));
        expectOk(body);
        expect(hasEvent("worker-result")(body.result.page)).toBe(true);
        expect(body.result.summary.experiment_url).toContain("/experiments/");
      }),
      { timeout: 240_000 },
    );

    test(
      "ReadWriteDataset fetches and summarizes the dataset",
      Effect.gen(function* () {
        expectOk(yield* call("/dataset/insert?id=worker-summarized"));
        // The summary counts a new record a moment after a fetch returns it.
        const body = yield* call(
          "/dataset",
          (result) =>
            hasEvent("worker-summarized")(result.page) &&
            result.summary.data_summary.total_records === result.page.events.length,
        );
        expectOk(body);
        expect(hasEvent("worker-summarized")(body.result.page)).toBe(true);
        expect(body.result.summary.data_summary.total_records).toBe(body.result.page.events.length);
      }),
      { timeout: 240_000 },
    );

    test(
      "ReadWriteDataset adds a record",
      Effect.gen(function* () {
        const body = yield* call("/dataset/insert");
        expectOk(body);
        expect(body.result.row_ids).toEqual(["worker-record"]);
      }),
      { timeout: 240_000 },
    );

    test(
      "RestoreDataset restores the dataset to an earlier version",
      Effect.gen(function* () {
        expectOk(yield* call("/dataset/insert?id=restore-kept"));
        const page = yield* call("/dataset", (result) => hasEvent("restore-kept")(result.page));
        expectOk(page);
        const kept = page.result.page.events.find((event: any) => event.id === "restore-kept");
        expectOk(yield* call("/dataset/insert?id=restore-dropped"));
        // A restore right after an insert misses it for a while; restoring the
        // same version again is a no-op once done.
        const restored = yield* call(
          `/dataset/restore?version=${kept._xact_id}`,
          (result) => result.rows_deleted > 0,
        );
        expectOk(restored);
        expect(restored.result).toMatchObject({ rows_restored: 0, rows_deleted: 1 });
        const after = yield* call("/dataset");
        const ids = after.result.page.events.map((event: any) => event.id);
        expect(ids).toContain("restore-kept");
        expect(ids).not.toContain("restore-dropped");
      }),
      { timeout: 240_000 },
    );

    test(
      "WriteProjectLogs logs an event and feedback",
      Effect.gen(function* () {
        const body = yield* call("/logs/write");
        expectOk(body);
        expect(body.result.inserted.row_ids).toEqual(["worker-write-log"]);
        expect(body.result.feedback.status).toBe("success");
      }),
      { timeout: 240_000 },
    );

    test(
      "WriteExperiment records a result and feedback",
      Effect.gen(function* () {
        const body = yield* call("/experiment/write");
        expectOk(body);
        expect(body.result.inserted.row_ids).toEqual(["worker-result"]);
        expect(body.result.feedback.status).toBe("success");
      }),
      { timeout: 240_000 },
    );

    test(
      "InvokeFunction runs the bound function",
      Effect.gen(function* () {
        const body = yield* call("/invoke");
        expectOk(body);
        expect(body.result).toEqual({ echo: "hi" });
      }),
      { timeout: 240_000 },
    );

    test(
      "LaunchEval runs an eval in the project",
      Effect.gen(function* () {
        const body = yield* call(`/eval?dataset=${datasetId}`);
        expectOk(body);
        expect(body.result.experimentUrl).toContain("/experiments/");
      }),
      { timeout: 240_000 },
    );

    test(
      "ProxyChatCompletions calls OpenAI with the bound secret's key",
      Effect.gen(function* () {
        const body = yield* call("/proxy");
        expectOk(body);
        expect(body.result.tag).toBe("Unauthorized");
        // The proxy's own 401 (no usable secret) says "Braintrust gateway error".
        expect(body.result.message).not.toContain("Braintrust gateway error");
      }),
      { timeout: 240_000 },
    );

    test(
      "InsertProjectLogs logs an event",
      Effect.gen(function* () {
        const body = yield* call("/InsertProjectLogs?id=worker-insert-log");
        expectOk(body);
        expect(body.result.row_ids).toEqual(["worker-insert-log"]);
      }),
      { timeout: 120_000 },
    );

    test(
      "FetchProjectLogs fetches the project's logs",
      Effect.gen(function* () {
        expectOk(yield* call("/InsertProjectLogs?id=worker-fetch-log"));
        const body = yield* call("/FetchProjectLogs", hasEvent("worker-fetch-log"));
        expectOk(body);
        expect(hasEvent("worker-fetch-log")(body.result)).toBe(true);
      }),
      { timeout: 240_000 },
    );

    test(
      "ReadProjectLogs fetches the project's logs",
      Effect.gen(function* () {
        expectOk(yield* call("/InsertProjectLogs?id=worker-read-log"));
        const body = yield* call("/ReadProjectLogs", hasEvent("worker-read-log"));
        expectOk(body);
        expect(hasEvent("worker-read-log")(body.result)).toBe(true);
      }),
      { timeout: 240_000 },
    );

    test(
      "ProjectLogFeedback scores a logged event",
      Effect.gen(function* () {
        expectOk(yield* call("/InsertProjectLogs?id=worker-log-feedback"));
        const body = yield* call("/ProjectLogFeedback?id=worker-log-feedback");
        expectOk(body);
        expect(body.result.status).toBe("success");
      }),
      { timeout: 240_000 },
    );

    test(
      "InsertExperimentEvents records a result",
      Effect.gen(function* () {
        const body = yield* call("/InsertExperimentEvents?id=worker-insert-result");
        expectOk(body);
        expect(body.result.row_ids).toEqual(["worker-insert-result"]);
      }),
      { timeout: 120_000 },
    );

    test(
      "FetchExperimentEvents fetches the experiment's events",
      Effect.gen(function* () {
        expectOk(yield* call("/InsertExperimentEvents?id=worker-fetch-result"));
        const body = yield* call("/FetchExperimentEvents", hasEvent("worker-fetch-result"));
        expectOk(body);
        expect(hasEvent("worker-fetch-result")(body.result)).toBe(true);
      }),
      { timeout: 240_000 },
    );

    test(
      "ExperimentFeedback comments on a recorded result",
      Effect.gen(function* () {
        expectOk(yield* call("/InsertExperimentEvents?id=worker-feedback-result"));
        const body = yield* call("/ExperimentFeedback?id=worker-feedback-result");
        expectOk(body);
        expect(body.result.status).toBe("success");
      }),
      { timeout: 240_000 },
    );

    test(
      "SummarizeExperiment summarizes the experiment",
      Effect.gen(function* () {
        const body = yield* call("/SummarizeExperiment");
        expectOk(body);
        expect(body.result.experiment_name).toBe(experimentName);
        expect(body.result.experiment_url).toContain("/experiments/");
      }),
      { timeout: 120_000 },
    );

    test(
      "ReadWriteExperiment reads back what it records",
      Effect.gen(function* () {
        const body = yield* call("/ReadWriteExperiment?id=worker-rw-result", (result) =>
          hasEvent("worker-rw-result")(result.page),
        );
        expectOk(body);
        expect(body.result.inserted.row_ids).toEqual(["worker-rw-result"]);
        expect(hasEvent("worker-rw-result")(body.result.page)).toBe(true);
      }),
      { timeout: 120_000 },
    );

    test(
      "InsertDatasetEvents adds a record",
      Effect.gen(function* () {
        const body = yield* call("/InsertDatasetEvents?id=worker-insert-record");
        expectOk(body);
        expect(body.result.row_ids).toEqual(["worker-insert-record"]);
      }),
      { timeout: 120_000 },
    );

    test(
      "FetchDatasetEvents fetches the dataset's records",
      Effect.gen(function* () {
        expectOk(yield* call("/InsertDatasetEvents?id=worker-fetch-record"));
        const body = yield* call("/FetchDatasetEvents", hasEvent("worker-fetch-record"));
        expectOk(body);
        expect(hasEvent("worker-fetch-record")(body.result)).toBe(true);
      }),
      { timeout: 240_000 },
    );

    test(
      "DatasetFeedback comments on a record",
      Effect.gen(function* () {
        expectOk(yield* call("/InsertDatasetEvents?id=worker-feedback-record"));
        const body = yield* call("/DatasetFeedback?id=worker-feedback-record");
        expectOk(body);
        expect(body.result.status).toBe("success");
      }),
      { timeout: 240_000 },
    );

    test(
      "SummarizeDataset counts the dataset's records",
      Effect.gen(function* () {
        expectOk(yield* call("/InsertDatasetEvents?id=worker-summarize-record"));
        const page = yield* call("/FetchDatasetEvents", hasEvent("worker-summarize-record"));
        expectOk(page);
        const records = page.result.events.length;
        // The summary counts a new record a moment after a fetch returns it.
        const body = yield* call(
          "/SummarizeDataset",
          (result) => result.data_summary.total_records === records,
        );
        expectOk(body);
        expect(body.result.data_summary.total_records).toBe(records);
      }),
      { timeout: 240_000 },
    );

    test(
      "ReadDataset fetches and summarizes the dataset",
      Effect.gen(function* () {
        expectOk(yield* call("/InsertDatasetEvents?id=worker-read-record"));
        const body = yield* call(
          "/ReadDataset",
          (result) =>
            hasEvent("worker-read-record")(result.page) &&
            result.summary.data_summary.total_records === result.page.events.length,
        );
        expectOk(body);
        expect(hasEvent("worker-read-record")(body.result.page)).toBe(true);
        expect(body.result.summary.data_summary.total_records).toBe(body.result.page.events.length);
      }),
      { timeout: 240_000 },
    );

    test(
      "WriteDataset adds a record and feedback",
      Effect.gen(function* () {
        const body = yield* call("/WriteDataset?id=worker-write-record");
        expectOk(body);
        expect(body.result.inserted.row_ids).toEqual(["worker-write-record"]);
        expect(body.result.feedback.status).toBe("success");
      }),
      { timeout: 120_000 },
    );

    test(
      "PreviewDatasetRestore previews restoring the dataset to an earlier version",
      Effect.gen(function* () {
        expectOk(yield* call("/InsertDatasetEvents?id=worker-preview-kept"));
        const page = yield* call("/FetchDatasetEvents", hasEvent("worker-preview-kept"));
        expectOk(page);
        const kept = page.result.events.find((event: any) => event.id === "worker-preview-kept");
        expectOk(yield* call("/InsertDatasetEvents?id=worker-preview-dropped"));
        const body = yield* call(
          `/PreviewDatasetRestore?version=${kept._xact_id}`,
          (result) => result.rows_to_delete > 0,
        );
        expectOk(body);
        expect(body.result).toEqual({ rows_to_restore: 0, rows_to_delete: 1 });
      }),
      { timeout: 240_000 },
    );

    for (const [binding, route] of [
      ["ProxyCompletions", "/ProxyCompletions"],
      ["ProxyEmbeddings", "/ProxyEmbeddings"],
      ["ProxyAuto", "/ProxyAuto"],
      ["ProxyRequest", "/ProxyRequest"],
    ] as const) {
      test(
        `${binding} calls OpenAI with the bound secret's key`,
        Effect.gen(function* () {
          const body = yield* call(route, reachedOpenAi);
          expectOk(body);
          expect(body.result.tag).toBe("Unauthorized");
          expect(body.result.message).not.toContain("Braintrust gateway error");
        }),
        { timeout: 120_000 },
      );
    }
  },
);
