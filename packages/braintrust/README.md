# @alchemy.run/braintrust

Braintrust for [Alchemy](https://alchemy.run). Declare the projects, datasets and experiments your evals use in the same TypeScript program as the rest of your app.

```sh
npm install alchemy @alchemy.run/braintrust effect
```

A project with a golden dataset and a pinned baseline experiment:

```typescript
// alchemy.run.ts
import * as Braintrust from "@alchemy.run/braintrust";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "SupportEvals",
  { providers: Braintrust.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const project = yield* Braintrust.Project("Support", {
      description: "Evals and logs for the support bot",
    });
    const dataset = yield* Braintrust.Dataset("Tickets", {
      projectId: project.projectId,
      tags: ["golden"],
    });
    const baseline = yield* Braintrust.Experiment("Baseline", {
      projectId: project.projectId,
      datasetId: dataset.datasetId,
    });
    return { projectId: project.projectId, baselineId: baseline.experimentId };
  }),
);
```

Set `BRAINTRUST_API_KEY` (and `BRAINTRUST_API_URL` for a self-hosted data plane), or store a key in a profile with `alchemy profile edit --add Braintrust`.

Reference: [alchemy.run/providers](https://alchemy.run/providers).
