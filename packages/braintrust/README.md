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

## Resources

Projects and what's in them:

- `Braintrust.Project`: a project, its settings and its project groups
- `Braintrust.Dataset`: versioned records that evals run against
- `Braintrust.DatasetSnapshot`: a named, pinned version of a dataset
- `Braintrust.Experiment`: one eval run, e.g. a pinned baseline
- `Braintrust.Prompt`: a versioned prompt, LLM scorer or tool
- `Braintrust.Function`: versioned code that runs as a scorer, task or tool
- `Braintrust.ProjectScore`: a human-review or computed score
- `Braintrust.ProjectTag`: a colored label for logs, rows and records
- `Braintrust.ProjectAutomation`: an alert, export or retention rule
- `Braintrust.View`: a saved filter, sort and column layout
- `Braintrust.CustomColumn`: a column computed from an expression
- `Braintrust.SpanIframe`: a custom page shown next to each span
- `Braintrust.McpServer`: a remote MCP server whose tools prompts can call
- `Braintrust.IngestKey`: a publishable key that only writes one project's logs

Organization:

- `Braintrust.OrganizationSettings`: the organization's settings
- `Braintrust.OrganizationMember`: a person invited by email
- `Braintrust.ServiceAccount` and `Braintrust.ServiceToken`: a non-human member and its API keys
- `Braintrust.Role`, `Braintrust.Group`, `Braintrust.ProjectGroup` and `Braintrust.Acl`: access control
- `Braintrust.AiSecret`: an LLM provider key for the playground, proxy and scorers
- `Braintrust.Environment`: a label such as `production` for prompt and function versions
- `Braintrust.EnvVar`: an encrypted variable for functions and scorers

Every resource also has `lookup`, to reference an object Alchemy doesn't manage.

Reference: [alchemy.run/providers](https://alchemy.run/providers).
