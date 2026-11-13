import * as Braintrust from "@alchemy.run/braintrust";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { eventually, expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Braintrust.providers() });

const tags = ["provider:braintrust", "provider:braintrust:organization-settings", "live"];

const currentOrg = braintrust.listOrganizations.items({}).pipe(
  Stream.runHead,
  Effect.map(Option.getOrUndefined),
  Effect.flatMap((org) =>
    org ? braintrust.getOrganization({ organization_id: org.id }) : Effect.die("no organization"),
  ),
);

/** Every field the organization has; data plane URLs must never move. */
const snapshot = (org: braintrust.Organization) => ({
  name: org.name,
  api_url: org.api_url ?? null,
  proxy_url: org.proxy_url ?? null,
  realtime_url: org.realtime_url ?? null,
  is_universal_api: org.is_universal_api ?? null,
  is_dataplane_private: org.is_dataplane_private ?? null,
});

test.provider(
  "change how images render and restore the captured value on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const before = yield* currentOrg;
      const beforeMode = before.image_rendering_mode ?? "auto";
      const target = beforeMode === "click_to_load" ? "blocked" : "click_to_load";

      const settings = yield* stack.deploy(
        Braintrust.OrganizationSettings("Settings", { imageRenderingMode: target }),
      );
      expect(settings.orgId).toBe(before.id);
      expect(settings.imageRenderingMode).toBe(target);
      expect(settings.original.imageRenderingMode).toBe(beforeMode);
      const changed = yield* currentOrg;
      expect(changed.image_rendering_mode).toBe(target);
      expect(snapshot(changed)).toEqual(snapshot(before));
      yield* expectFound(Braintrust.OrganizationSettings.lookup({}), {
        ...settings,
        original: { imageRenderingMode: target },
      });

      const plan = yield* stack.plan(
        Braintrust.OrganizationSettings("Settings", { imageRenderingMode: target }),
      );
      expect(plan.resources.Settings.action).toBe("noop");

      // A setting left unset is not managed: the deployed value stays.
      const unmanaged = yield* stack.deploy(Braintrust.OrganizationSettings("Settings", {}));
      expect(unmanaged.imageRenderingMode).toBe(target);
      expect(unmanaged.original.imageRenderingMode).toBe(beforeMode);
      yield* eventually(currentOrg, (observed) => {
        expect(observed.image_rendering_mode).toBe(target);
      });

      yield* stack.destroy();
      yield* eventually(currentOrg, (after) => {
        expect(after.image_rendering_mode ?? "auto").toBe(beforeMode);
        expect(snapshot(after)).toEqual(snapshot(before));
      });
    }),
  { tags, exclusive: "braintrust:org-settings", timeout: 120_000 },
);
