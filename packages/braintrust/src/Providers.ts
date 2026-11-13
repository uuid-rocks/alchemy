import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { Acl, AclProvider } from "./Acl.ts";
import { AiSecret, AiSecretProvider } from "./AiSecret.ts";
import { BraintrustAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { CustomColumn, CustomColumnProvider } from "./CustomColumn.ts";
import { Dataset, DatasetProvider } from "./Dataset.ts";
import { DatasetSnapshot, DatasetSnapshotProvider } from "./DatasetSnapshot.ts";
import { Environment, EnvironmentProvider } from "./Environment.ts";
import { EnvVar, EnvVarProvider } from "./EnvVar.ts";
import { Experiment, ExperimentProvider } from "./Experiment.ts";
import { Group, GroupProvider } from "./Group.ts";
import { IngestKey, IngestKeyProvider } from "./IngestKey.ts";
import { McpServer, McpServerProvider } from "./McpServer.ts";
import { OrganizationMember, OrganizationMemberProvider } from "./OrganizationMember.ts";
import { OrganizationSettings, OrganizationSettingsProvider } from "./OrganizationSettings.ts";
import { Project, ProjectProvider } from "./Project.ts";
import { ProjectAutomation, ProjectAutomationProvider } from "./ProjectAutomation.ts";
import { ProjectGroup, ProjectGroupProvider } from "./ProjectGroup.ts";
import { ProjectScore, ProjectScoreProvider } from "./ProjectScore.ts";
import { ProjectTag, ProjectTagProvider } from "./ProjectTag.ts";
import { Role, RoleProvider } from "./Role.ts";
import { ServiceAccount, ServiceAccountProvider } from "./ServiceAccount.ts";
import { ServiceToken, ServiceTokenProvider } from "./ServiceToken.ts";
import { SpanIframe, SpanIframeProvider } from "./SpanIframe.ts";
import { View, ViewProvider } from "./View.ts";

/**
 * Service tag bundling all Braintrust providers + auth + credentials. Use
 * `Braintrust.providers()` to materialize the full layer.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("Braintrust") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build the complete Braintrust providers Layer: every Braintrust resource,
 * the Braintrust AuthProvider registration (so `alchemy profile edit` can
 * configure it), and credential resolution.
 *
 * @example
 * ```ts
 * Alchemy.Stack("App", { providers: Braintrust.providers() }, ...)
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      AiSecret,
      Dataset,
      Environment,
      EnvVar,
      Experiment,
      IngestKey,
      McpServer,
      Project,
      CustomColumn,
      DatasetSnapshot,
      ProjectAutomation,
      ProjectScore,
      ProjectTag,
      SpanIframe,
      View,
      Acl,
      Group,
      OrganizationMember,
      OrganizationSettings,
      ProjectGroup,
      Role,
      ServiceAccount,
      ServiceToken,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AiSecretProvider(),
        DatasetProvider(),
        EnvironmentProvider(),
        EnvVarProvider(),
        ExperimentProvider(),
        IngestKeyProvider(),
        McpServerProvider(),
        ProjectProvider(),
        CustomColumnProvider(),
        DatasetSnapshotProvider(),
        ProjectAutomationProvider(),
        ProjectScoreProvider(),
        ProjectTagProvider(),
        SpanIframeProvider(),
        ViewProvider(),
        AclProvider(),
        GroupProvider(),
        OrganizationMemberProvider(),
        OrganizationSettingsProvider(),
        ProjectGroupProvider(),
        RoleProvider(),
        ServiceAccountProvider(),
        ServiceTokenProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(BraintrustAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
