import * as Contributions from "alchemy/Contributions";

export default Contributions.make({
  name: "braintrust",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.BraintrustAuth,
  ),
});
