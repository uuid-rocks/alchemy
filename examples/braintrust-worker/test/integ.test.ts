import { expect } from "bun:test";
import * as Braintrust from "@alchemy.run/braintrust";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Test from "@alchemy.run/test/Bun";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Braintrust.providers()),
  state: Alchemy.localState(),
});

const { getWhenReady } = Test;

// Out-of-band calls resolve the same Braintrust credentials the deploy uses.
const BraintrustHttp = Layer.mergeAll(
  Braintrust.BraintrustAuth,
  Braintrust.fromAuthProvider(),
  FetchHttpClient.layer,
);

const stack = beforeAll(deploy(Stack), { timeout: 600_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { projectId } = yield* stack;
    yield* destroy(Stack);
    // Deleting the project deletes its dataset, function and logs with it.
    const project = yield* braintrust.getProject({ project_id: projectId }).pipe(
      Effect.map((project) => project.deleted_at ?? "found"),
      Effect.catchTag("NotFoundOrForbidden", () => Effect.succeed("gone")),
      Effect.provide(BraintrustHttp),
    );
    expect(project).not.toBe("found");
  }),
  { timeout: 600_000 },
);

type Triage = { queue: string; logId: string; recordId: string };

const triage = (url: string, question: unknown) =>
  HttpClient.execute(
    HttpClientRequest.post(`${url}/tickets`).pipe(HttpClientRequest.bodyJsonUnsafe({ question })),
  );

/** Fetches until row `id` shows up: a write takes a few seconds to be readable. */
const readBack = <E, R>(
  fetch: Effect.Effect<{ readonly events: ReadonlyArray<{ readonly id: string }> }, E, R>,
  id: string,
) =>
  fetch.pipe(
    Effect.map((page) => page.events.find((event) => event.id === id) as any),
    Effect.repeat({
      until: (event) => event !== undefined,
      schedule: Schedule.spaced("2 seconds"),
      times: 30,
    }),
  );

test(
  "rejects a ticket without a question",
  Effect.gen(function* () {
    const { url } = yield* stack;
    yield* getWhenReady(url);
    const response = yield* triage(url, 42);
    expect(response.status).toBe(400);
  }),
  { timeout: 120_000 },
);

test(
  "triages a ticket, logs the call and adds it to the dataset",
  Effect.gen(function* () {
    const { url, projectId, datasetId } = yield* stack;
    yield* getWhenReady(url);

    // The Worker's Braintrust token can take a few seconds to be accepted
    // after a fresh deploy; until then the Worker answers 502.
    const answer = (question: string) =>
      triage(url, question).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? (response.json as Effect.Effect<unknown>)
            : Effect.flatMap(response.text, (body) => Effect.fail(`${response.status} ${body}`)),
        ),
        Effect.map((body) => body as Triage),
        Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 20 }),
      );

    const billing = yield* answer("I was charged twice on my last invoice");
    expect(billing.queue).toBe("billing");
    const general = yield* answer("How do I reset my password?");
    expect(general.queue).toBe("general");

    // Both writes are real Braintrust rows, read back with the deployer's key.
    const log = yield* readBack(
      braintrust
        .fetchProjectLogEvents({ project_id: projectId })
        .pipe(Effect.provide(BraintrustHttp)),
      billing.logId,
    );
    expect(log.input).toBe("I was charged twice on my last invoice");
    expect(log.output).toBe("billing");

    const record = yield* readBack(
      braintrust.fetchDatasetEvents({ dataset_id: datasetId }).pipe(Effect.provide(BraintrustHttp)),
      general.recordId,
    );
    expect(record.input).toBe("How do I reset my password?");
    expect(record.expected).toBe("general");
    expect(record.metadata).toEqual({ logId: general.logId });
  }),
  { timeout: 300_000 },
);
