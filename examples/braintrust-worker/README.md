# Support triage on a Cloudflare Worker with Braintrust

A Cloudflare Worker that triages support questions. Each `POST /tickets` runs a Braintrust function to pick a queue, logs the call to the project's logs, and adds the question to a dataset with the chosen queue as its expected answer, ready for an eval.

```sh
curl -X POST "$URL/tickets" -d '{"question":"I was charged twice on my last invoice"}'
# 200 {"queue":"billing","logId":"…","recordId":"…"}
```

## Architecture

- [`Support`](./src/resources.ts): `Braintrust.Project`, holding the logs, the dataset and the function.
- [`Tickets`](./src/resources.ts): `Braintrust.Dataset`, one record per triaged question.
- [`Classify`](./src/resources.ts): `Braintrust.Function`, an inline code task that runs in Braintrust and returns `billing` or `general`.
- [`Api`](./src/Api.ts): `Cloudflare.Worker` serving `POST /tickets`.

## Bindings

Braintrust has no workload identity, so each binding gives the Worker its own Braintrust service account and token, created at deploy and bound into the Worker as a secret. Destroying the Worker revokes the token and deletes the account.

| Binding | Grant on the Worker's service account |
| --- | --- |
| `Braintrust.InvokeFunction(Classify)` + `InvokeFunctionHttp` | `read` on the function |
| `Braintrust.WriteProjectLogs(Support)` + `WriteProjectLogsHttp` | `update` on the project's logs |
| `Braintrust.WriteDataset(Tickets)` + `WriteDatasetHttp` | `update` on the dataset |

The Worker can't read the logs or the dataset back, and can't touch any other project.

## Deploy

The Worker's bindings create its own Braintrust service account and token, so deploy with a service token (`bt-st-…`) that holds `read_acls` on the organization. Braintrust won't create service tokens for a user key (`sk-…`).

Set `BRAINTRUST_API_KEY` (or pick Braintrust in `alchemy profile`) and your Cloudflare credentials, then from the repository root:

```sh
pnpm install
cd examples/braintrust-worker
pnpm deploy
```

## Live test

```sh
bun test test/integ.test.ts
```

The test deploys the stack, posts two questions, checks the queue each one gets, reads the log row and the dataset record back through the Braintrust API, then destroys the stack and checks the project is gone.

## Destroy

```sh
pnpm destroy
```
