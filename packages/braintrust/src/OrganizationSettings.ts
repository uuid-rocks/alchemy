import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Providers } from "./Providers.ts";

export interface OrganizationSettingsProps {
  /**
   * How the Braintrust UI renders images in logs and experiments: `auto`
   * loads them, `click_to_load` shows a placeholder until clicked, and
   * `blocked` never loads them. Left unset, the setting is not managed.
   */
  imageRenderingMode?: braintrust.ImageRenderingMode;
}

interface Captured {
  imageRenderingMode: braintrust.ImageRenderingMode;
}

export interface OrganizationSettingsAttributes {
  /** Id of the organization. Use it as `objectId` for organization-wide ACLs. */
  orgId: string;
  /** Organization name. */
  name: string;
  /** How the UI renders images. */
  imageRenderingMode: braintrust.ImageRenderingMode;
  /** URL of the organization's data plane API; `undefined` for Braintrust-hosted. */
  apiUrl: string | undefined;
  /** URL of the organization's AI proxy. */
  proxyUrl: string | undefined;
  /** URL of the organization's realtime service. */
  realtimeUrl: string | undefined;
  /** The settings before Alchemy first changed them; restored on destroy. */
  original: Captured;
}

export type OrganizationSettings = Resource<
  "Braintrust.OrganizationSettings",
  OrganizationSettingsProps,
  OrganizationSettingsAttributes,
  never,
  Providers,
  OrganizationSettingsLookup
>;

/** Props for {@link OrganizationSettings.lookup}: the credentials' organization. */
export type OrganizationSettingsLookup = Record<string, never>;

/**
 * Settings of the Braintrust organization the credentials belong to. Only
 * the settings you declare are changed.
 *
 * The organization always exists, so this resource captures the settings
 * it finds on first deploy and puts them back on destroy. Braintrust can't
 * set a setting back to "unset", so an unset `imageRenderingMode` is
 * restored as `auto`, which behaves the same. See
 * [Organizations](https://www.braintrust.dev/docs/guides/access-control).
 *
 * The data plane URLs are read-only here: a wrong value cuts the whole
 * organization off from its data, and the API can't unset them again.
 *
 * ### Configuring the Organization
 * **Example:** Load images only when clicked
 * ```typescript
 * const settings = yield* Braintrust.OrganizationSettings("Settings", {
 *   imageRenderingMode: "click_to_load",
 * });
 * ```
 *
 * ### Granting organization-wide access
 * **Example:** Let a group read everything in the organization
 * ```typescript
 * const org = Braintrust.OrganizationSettings.lookup({});
 * const auditors = yield* Braintrust.Group("Auditors", {});
 * yield* Braintrust.Acl("AuditorsReadAll", {
 *   objectType: "organization",
 *   objectId: org.orgId,
 *   groupId: auditors.groupId,
 *   permission: "read",
 * });
 * ```
 *
 * @resource
 * @product Organization
 */
export const OrganizationSettings = Resource<OrganizationSettings>(
  "Braintrust.OrganizationSettings",
);

/** The credentials can see no organization. */
export class OrganizationNotFound extends Data.TaggedError("OrganizationNotFound")<{}> {
  override get message() {
    return "The Braintrust credentials belong to no organization";
  }
}

// An organization that never set it shows `null`, which renders like `auto`;
// PATCH can't send `null` back, so `auto` is the value to compare and restore.
const imageModeOf = (org: braintrust.Organization): braintrust.ImageRenderingMode =>
  org.image_rendering_mode ?? "auto";

const toAttributes = (
  org: braintrust.Organization,
  original: Captured,
): OrganizationSettingsAttributes => ({
  orgId: org.id,
  name: org.name,
  imageRenderingMode: imageModeOf(org),
  apiUrl: org.api_url ?? undefined,
  proxyUrl: org.proxy_url ?? undefined,
  realtimeUrl: org.realtime_url ?? undefined,
  original,
});

/** The organization the credentials act in; a service token belongs to exactly one. */
const currentOrganization = braintrust.listOrganizations.items({}).pipe(
  Stream.runHead,
  Effect.map(Option.getOrUndefined),
  Effect.flatMap((org) => (org ? Effect.succeed(org) : Effect.fail(new OrganizationNotFound()))),
);

const observe = (orgId: string | undefined) =>
  orgId
    ? braintrust
        .getOrganization({ organization_id: orgId })
        .pipe(Effect.catchTag("NotFoundOrForbidden", () => Effect.undefined))
    : currentOrganization;

const apply = Effect.fn(function* (
  org: braintrust.Organization,
  want: { imageRenderingMode?: braintrust.ImageRenderingMode },
) {
  if (want.imageRenderingMode === undefined || want.imageRenderingMode === imageModeOf(org)) {
    return org;
  }
  return yield* braintrust.updateOrganization({
    organization_id: org.id,
    image_rendering_mode: want.imageRenderingMode,
  });
});

export const OrganizationSettingsProvider = () =>
  Provider.effect(
    OrganizationSettings,
    Effect.gen(function* () {
      return {
        stables: ["orgId", "original"],
        nuke: { singleton: true },
        list: () => Effect.succeed([]),
        lookup: Effect.fn(function* () {
          const org = yield* currentOrganization;
          return toAttributes(org, { imageRenderingMode: imageModeOf(org) });
        }),
        read: Effect.fn(function* ({ output }) {
          const org = yield* observe(output?.orgId);
          if (!org) return undefined;
          return toAttributes(org, output?.original ?? { imageRenderingMode: imageModeOf(org) });
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          // Observe
          const org = (yield* observe(output?.orgId)) ?? (yield* currentOrganization);
          const original = output?.original ?? { imageRenderingMode: imageModeOf(org) };
          // Sync only what is declared, against the observed settings.
          if (
            news.imageRenderingMode !== undefined &&
            news.imageRenderingMode !== imageModeOf(org)
          ) {
            yield* session.note(`Updating organization ${org.name} settings...`);
          }
          const updated = yield* apply(org, { imageRenderingMode: news.imageRenderingMode });
          return toAttributes(updated, original);
        }),
        delete: Effect.fn(function* ({ output }) {
          const org = yield* observe(output.orgId);
          if (!org) return;
          yield* apply(org, output.original);
        }),
      };
    }),
  );
