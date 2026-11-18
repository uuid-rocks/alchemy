import * as braintrust from "@distilled.cloud/braintrust/braintrust";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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

/** Only the settings the props have managed are captured. */
interface Captured {
  imageRenderingMode?: braintrust.ImageRenderingMode;
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
  /**
   * Each managed setting as it was before the props first set it; only these
   * are restored on destroy.
   */
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
 * The organization always exists, so this resource captures each setting
 * as it finds it when the props first set it, and puts those back on
 * destroy. A setting never declared is never restored. Braintrust can't
 * set a setting back to "unset", so an unset `imageRenderingMode` is
 * restored as `auto`, which behaves the same. See
 * [Organizations](https://www.braintrust.dev/docs/guides/access-control).
 *
 * The data plane settings are read-only here: the URLs, and whether the
 * data plane at `apiUrl` also serves the AI proxy (`is_universal_api`). A
 * wrong value cuts the whole organization off from its data or its proxy,
 * and the API can't unset them again. Nor is `is_dataplane_private`
 * managed: it records whether a self-hosted data plane is reachable only
 * from a private network, a fact about that network Alchemy can't check. The organization's name isn't
 * managed either: clients that select the organization by name
 * (`BRAINTRUST_ORG_NAME`, `orgName`) stop finding it after a rename.
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

/** The credentials belong to more than one organization. */
export class AmbiguousOrganization extends Data.TaggedError("AmbiguousOrganization")<{}> {
  override get message() {
    return "The Braintrust credentials belong to more than one organization; use a service token, which belongs to exactly one";
  }
}

/**
 * The organization the credentials act in. A service token belongs to
 * exactly one; a user's API key can belong to several, and the credentials
 * name none, so that is refused rather than guessed.
 */
const currentOrganization = braintrust.listOrganizations.items({}).pipe(
  Stream.take(2),
  Stream.runCollect,
  Effect.flatMap(
    ([org, other]): Effect.Effect<
      braintrust.Organization,
      OrganizationNotFound | AmbiguousOrganization
    > =>
      !org
        ? Effect.fail(new OrganizationNotFound())
        : other
          ? Effect.fail(new AmbiguousOrganization())
          : Effect.succeed(org),
  ),
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
        stables: ["orgId"],
        nuke: { singleton: true },
        list: () => Effect.succeed([]),
        lookup: Effect.fn(function* () {
          const org = yield* currentOrganization;
          return toAttributes(org, {});
        }),
        read: Effect.fn(function* ({ output }) {
          const org = yield* observe(output?.orgId);
          if (!org) return undefined;
          return toAttributes(org, output?.original ?? {});
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          // Observe
          const org = (yield* observe(output?.orgId)) ?? (yield* currentOrganization);
          const original: Captured = { ...output?.original };
          if (news.imageRenderingMode !== undefined) {
            original.imageRenderingMode ??= imageModeOf(org);
          }
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
