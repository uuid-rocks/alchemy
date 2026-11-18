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

// Runs without a Cloudflare account (forks, local runs) skip this suite;
// `../Bindings.test.ts` still runs every binding in-process.
const hasCloudflare = !!(process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_KEY);

const testOptions = { providers: Layer.mergeAll(Braintrust.providers(), Cloudflare.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BraintrustExternalHost", import.meta.url);

type Body = { ok: boolean; result?: any; error?: string };

let url: string;
let datasetId: string;

// A fresh workers.dev URL and new ACLs take a while to propagate: retry until
// the route answers `ok`, then report the last answer so a real failure shows
// Braintrust's error.
const call = (route: string) =>
  HttpClient.get(`${url}${route}`).pipe(
    Effect.timeout("30 seconds"),
    Effect.flatMap((response) => response.json),
    Effect.map((body) => body as Body),
    Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
    Effect.catch((body) => Effect.succeed(body as Body)),
  );

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

describe.skipIf(!hasCloudflare)(
  "Braintrust bindings on a Cloudflare Worker",
  { tags: ["provider:braintrust", "provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const worker = yield* BraintrustWorker;
            yield* Experiment;
            yield* Echo;
            const dataset = yield* Dataset;
            return { url: worker.url.as<string>(), datasetId: dataset.datasetId };
          }),
        );
        url = out.url;
        datasetId = out.datasetId;
      }),
      { timeout: 600_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    test(
      "ReadWriteProjectLogs fetches the project's logs",
      Effect.gen(function* () {
        const body = yield* call("/logs");
        expectOk(body);
        expect(Array.isArray(body.result.events)).toBe(true);
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
        const body = yield* call("/experiment");
        expectOk(body);
        expect(Array.isArray(body.result.page.events)).toBe(true);
        expect(body.result.summary.experiment_url).toContain("/experiments/");
      }),
      { timeout: 240_000 },
    );

    test(
      "ReadWriteDataset fetches and summarizes the dataset",
      Effect.gen(function* () {
        const body = yield* call("/dataset");
        expectOk(body);
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
        const kept = yield* call("/dataset").pipe(
          Effect.map((body) =>
            body.result?.page.events.find((event: any) => event.id === "restore-kept"),
          ),
          Effect.repeat({
            until: (event) => event !== undefined,
            schedule: Schedule.spaced("2 seconds"),
            times: 30,
          }),
        );
        expectOk(yield* call("/dataset/insert?id=restore-dropped"));
        // A restore right after an insert misses it for a while; restoring the
        // same version again is a no-op once done.
        const restored = yield* call(`/dataset/restore?version=${kept._xact_id}`).pipe(
          Effect.repeat({
            until: (body) => body.result?.rows_deleted > 0,
            schedule: Schedule.spaced("3 seconds"),
            times: 30,
          }),
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
  },
);
