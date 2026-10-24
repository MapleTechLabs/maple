import {
	BillingCustomer,
	CloudflareIntegrationStatus,
	CloudflareUsageResponse,
	GcpResourcesResponse,
	GithubIntegrationStatus,
	HazelIntegrationStatus,
	RailwayIntegrationStatus,
	ScrapeTargetId,
	SupabaseIntegrationStatus,
	VcsRepositoryId,
} from "@maple/domain/http"
import {
	V2AwsConnection,
	V2AwsIntegration,
	V2AwsIngest,
	V2AwsSetup,
	V2ChatConnectorList,
	V2GcpConnector,
	V2GcpIntegration,
	V2GcpSetupScripts,
	V2PlanetScaleDatabaseList,
	V2PlanetScaleIntegration,
	V2PlanetScaleOrganizationList,
	V2ScrapeTarget,
	V2ScrapeTargetCheck,
} from "@maple/domain/http/v2"
import {
	AwsConnectionId,
	ChatWorkspaceId,
	GcpConnectorId,
	GcpLogRuntime,
	SupabaseProjectRef,
} from "@maple/domain/primitives"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/load-failure"
import * as CopyButton from "../../ui/copy-button"
import * as Dialog from "../../ui/dialog"
import * as Popover from "../../ui/popover"
import * as Field from "../../ui/field"
import * as Menu from "../../ui/menu"
import * as Select from "../../ui/select"
import { FormFieldName } from "./prometheus-form-field"
import * as ToggleGroup from "../../ui/toggle-group"
import * as Chart from "../../charts/chart"
import { ConnectProvider } from "./connect"
import { OAuthReturnOutcome } from "./oauth-return"
import { FleetRead } from "../infra-integrations/gcp/data"
import { SupabaseProjectRow } from "../infra-integrations/supabase/model"
import { Capability, GcpFlags, SetupMethod } from "./gcp-configure-schema"
import { ConfigureTarget, LogVolume, RemovedConnector } from "./gcp-schema"
import { AwsRemovedStack, AwsSetupMethod } from "./aws-schema"

export const StatusName = Schema.Literals([
	"cloudflare",
	"railway",
	"planetscale",
	"planetscaleDatabases",
	"gcp",
	"aws",
	"supabase",
	"hazel",
	"github",
	"chat",
	"scrapeTargets",
])
export type StatusName = typeof StatusName.Type

const result = <A, AI>(schema: Schema.Codec<A, AI>) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedReadClock: { nowMs: Schema.Number },
	CompletedLoadCloudflare: result(CloudflareIntegrationStatus),
	CompletedLoadRailway: result(RailwayIntegrationStatus),
	CompletedLoadPlanetscale: result(V2PlanetScaleIntegration),
	CompletedLoadPlanetscaleDatabases: result(V2PlanetScaleDatabaseList),
	CompletedLoadGcp: result(V2GcpIntegration),
	CompletedLoadAws: result(V2AwsIntegration),
	CompletedLoadSupabase: result(SupabaseIntegrationStatus),
	CompletedLoadHazel: result(HazelIntegrationStatus),
	CompletedLoadGithub: result(GithubIntegrationStatus),
	CompletedLoadChat: result(V2ChatConnectorList),
	CompletedLoadScrapeTargets: result(Schema.Array(V2ScrapeTarget)),
	CompletedLoadCustomer: result(BillingCustomer),
	/** `trackProduct("integration_connected")` was handed to the session SDK. */
	CompletedTrackConnected: {},
	/** The shared session read answered (`useIsOrgAdmin`). */
	CompletedLoadSession: { isAdmin: Schema.Boolean },
	/** A catalog row or card, or the header's back button (`navigate({ search })`). */
	ClickedIntegration: { integration: Schema.NullOr(Schema.String) },
	/** A settings nav tab (`navigate({ to: "/settings", search: { tab } })`). */
	ClickedSettingsTab: { tab: Schema.String },
	/** The chat callback toast went out; the return params are stripped next (a replace). */
	CompletedChatToast: {},
	/** The header or card Connect button: a new popup attempt for the page's provider. */
	ClickedConnect: {},
	SucceededStartConnect: { attempt: Schema.Number },
	FailedStartConnect: { attempt: Schema.Number, title: Schema.String, description: Schema.String },
	/** The authorize URL arrived but the popup was gone and could not be reopened. */
	BlockedConnectPopup: { attempt: Schema.Number },
	/** Every 3 s while a polling provider's popup is out (`onPoll`). */
	PolledConnect: { attempt: Schema.Number },
	ClosedConnectPopup: { attempt: Schema.Number },
	EndedConnectGrace: { attempt: Schema.Number },
	/** The callback page's `postMessage` (`maple:integration:<provider>`). */
	ClickedRetryStatus: { name: StatusName },
	ClickedDisconnect: {},
	GotDisconnectDialogMessage: { message: Dialog.Message },
	ConfirmedDisconnect: {},
	CompletedDisconnect: { integration: Schema.String, failure: Schema.NullOr(LoadFailure) },
	ClickedChatInstall: {},
	CompletedChatInstall: { failure: Schema.NullOr(LoadFailure) },
	ClickedChatIdentity: {},
	CompletedChatIdentity: { kind: Schema.Literals(["link", "unlink"]), failure: Schema.NullOr(LoadFailure) },
	ClickedChatDisconnect: { workspaceId: ChatWorkspaceId },
	CompletedChatDisconnect: { failure: Schema.NullOr(LoadFailure) },
	ClickedGithubRefresh: {},
	CompletedGithubRefreshSpin: { version: Schema.Number },
	ToggledCiTraces: {},
	CompletedCiTraces: { enabled: Schema.Boolean, failure: Schema.NullOr(LoadFailure) },
	/** The 3 s status poll while the popup is out, a branch change settles or a repo syncs. */
	TickedGithubPoll: {},
	EndedGithubForcePoll: { version: Schema.Number },
	ClickedRepoDelete: { repoId: VcsRepositoryId },
	GotRepoDeleteDialogMessage: { message: Dialog.Message },
	ConfirmedRepoDelete: {},
	CompletedRepoDelete: { repoId: VcsRepositoryId, failure: Schema.NullOr(LoadFailure) },
	GotBranchPopoverMessage: { repoId: VcsRepositoryId, message: Popover.Message },
	ChangedBranchQuery: { value: Schema.String },
	ClickedBranch: { repoId: VcsRepositoryId, branch: Schema.String },
	GotBranchDialogMessage: { message: Dialog.Message },
	ConfirmedBranch: {},
	CompletedTrackedBranch: {
		repoId: VcsRepositoryId,
		branch: Schema.String,
		backfillQueued: Schema.Boolean,
		failure: Schema.NullOr(LoadFailure),
	},
	CompletedLoadCloudflareUsage: result(CloudflareUsageResponse),
	CompletedCloudflarePrime: { isConnected: Schema.Boolean, isOk: Schema.Boolean },
	/** Every 30 s while a fresh Cloudflare connection settles (`useCloudflareIngestPhase`). */
	TickedCloudflareIngest: {},
	GotZoneFilterMessage: { message: ToggleGroup.Message },
	ChangedZoneSearch: { value: Schema.String },
	ClickedZoneSort: { key: Schema.Literals(["name", "status", "requests"]) },
	ClickedWorkersExpand: {},
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	GotSparklineMessage: { message: Chart.Message },
	ClickedTarget: { id: ScrapeTargetId },
	/** A press inside a row's switch or menu cell, which does not select the row. */
	ClickedTargetControls: {},
	CompletedFetchChecks: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(V2ScrapeTargetCheck), LoadFailure),
	},
	/** `useIntervalRefresh`: the target list every 30 s, the selected target's checks every 10 s. */
	TickedTargetsRefresh: {},
	TickedChecksRefresh: {},
	ClickedProbe: { id: ScrapeTargetId },
	CompletedProbe: {
		id: ScrapeTargetId,
		failure: Schema.NullOr(LoadFailure),
		success: Schema.Boolean,
		error: Schema.NullOr(Schema.String),
	},
	ClickedToggleTarget: { id: ScrapeTargetId },
	CompletedToggle: { id: ScrapeTargetId, failure: Schema.NullOr(LoadFailure) },
	ClickedAddTarget: {},
	ClickedEditTarget: { id: ScrapeTargetId },
	ClickedDeleteTarget: { id: ScrapeTargetId },
	GotTargetMenuMessage: { id: ScrapeTargetId, message: Menu.Message },
	GotFormDialogMessage: { message: Dialog.Message },
	GotFormFieldMessage: { field: FormFieldName, message: Field.Message },
	GotAuthSelectMessage: { message: Select.Message },
	SubmittedTargetForm: {},
	CompletedSave: {
		isEdit: Schema.Boolean,
		id: Schema.NullOr(ScrapeTargetId),
		failure: Schema.NullOr(LoadFailure),
	},
	GotTargetDeleteDialogMessage: { message: Dialog.Message },
	ConfirmedTargetDelete: {},
	CompletedTargetDelete: { id: ScrapeTargetId, failure: Schema.NullOr(LoadFailure) },
	GotRailwayTokenMessage: { message: Field.Message },
	SubmittedRailwayToken: {},
	SucceededRailwayConnect: { title: Schema.String, description: Schema.String },
	FailedRailwayConnect: { error: Schema.String },
	ClickedRailwaySync: {},
	CompletedRailwaySync: { failure: Schema.NullOr(LoadFailure) },
	ClickedRailwayRotate: {},
	ClickedRailwayRotateCancel: {},
	/** Every 15 s while environments wait for their first sync. */
	TickedRailwaySettle: {},
	GotAwsAccountIdMessage: { message: Field.Message },
	GotAwsRegionsMessage: { message: Field.Message },
	SubmittedAwsAccount: {},
	SucceededAwsCreate: { connection: V2AwsConnection },
	FailedAwsCreate: { error: Schema.String },
	ClickedAwsAdd: {},
	ClickedAwsAddCancel: {},
	ClickedAwsSetup: { id: AwsConnectionId },
	ClickedAwsSetupClose: {},
	CompletedLoadAwsSetup: result(V2AwsSetup),
	CompletedLoadAwsIngest: { id: AwsConnectionId, ...result(V2AwsIngest) },
	ClickedAwsSetupMethod: { method: AwsSetupMethod },
	ClickedAwsCheck: { id: AwsConnectionId },
	/** The background re-check of connections still waiting for their stack. */
	TickedAwsPending: {},
	/** A streaming connection's status and ingest are read again. */
	TickedAwsWatch: {},
	CompletedAwsCheck: {
		id: AwsConnectionId,
		quiet: Schema.Boolean,
		connection: Schema.NullOr(V2AwsConnection),
		failure: Schema.NullOr(LoadFailure),
	},
	GotAwsCopyMessage: { id: Schema.String, message: CopyButton.Message },
	ClickedAwsDisconnect: { id: AwsConnectionId },
	GotAwsDisconnectDialogMessage: { message: Dialog.Message },
	ConfirmedAwsDisconnect: {},
	CompletedAwsDisconnect: {
		id: AwsConnectionId,
		removed: Schema.NullOr(AwsRemovedStack),
		error: Schema.NullOr(Schema.String),
	},
	DismissedAwsRemoved: { connectionId: Schema.String },
	CompletedReadAwsRemoved: { removed: Schema.Array(AwsRemovedStack) },
	CompletedWriteAwsRemoved: {},
	ClickedAwsMetrics: { id: AwsConnectionId },
	ClickedAwsMetricsCancel: {},
	GotAwsMetricsRegionsMessage: { message: Field.Message },
	SubmittedAwsMetrics: {},
	CompletedAwsMetricStream: {
		connection: Schema.NullOr(V2AwsConnection),
		error: Schema.NullOr(Schema.String),
	},
	ClickedSupabaseSync: {},
	/** Every minute while the connected Supabase card is shown, so its window and ages advance. */
	TickedSupabaseClock: {},
	/** The clock read after a settled switch; its rows re-read supersedes on the fresh window. */
	CompletedReadSupabaseClock: { nowMs: Schema.Number },
	CompletedLoadSupabaseMetrics: result(Schema.Array(SupabaseProjectRow)),
	CompletedSupabaseSync: { failure: Schema.NullOr(LoadFailure) },
	/** A project row's "Collect metrics" switch. */
	ToggledSupabaseMetrics: { ref: SupabaseProjectRef, enabled: Schema.Boolean },
	CompletedSupabaseMetrics: {
		ref: SupabaseProjectRef,
		enabled: Schema.Boolean,
		failure: Schema.NullOr(LoadFailure),
	},
	/** A project row's "Collect logs" switch. */
	ToggledSupabaseLogs: { ref: SupabaseProjectRef, enabled: Schema.Boolean },
	CompletedSupabaseLogs: {
		ref: SupabaseProjectRef,
		enabled: Schema.Boolean,
		failure: Schema.NullOr(LoadFailure),
	},
	/** A project row's "Log drain" switch: creates or deletes the drain at Supabase. */
	ToggledSupabaseLogDrain: { ref: SupabaseProjectRef, enabled: Schema.Boolean },
	CompletedSupabaseLogDrain: {
		ref: SupabaseProjectRef,
		enabled: Schema.Boolean,
		failure: Schema.NullOr(LoadFailure),
	},
	CompletedFetchOrganizations: result(V2PlanetScaleOrganizationList),
	ClickedChangeOrganization: {},
	GotPickerDialogMessage: { message: Dialog.Message },
	SelectedOrganization: { name: Schema.String },
	GotBranchFieldMessage: { field: Schema.Literals(["include", "exclude"]), message: Field.Message },
	ClickedPickerCancel: {},
	SubmittedOrganization: {},
	CompletedSelectOrganization: { organization: Schema.String, failure: Schema.NullOr(LoadFailure) },
	ClickedMetricsDetails: {},
	/** Every 5 s while the first scrape is awaited. */
	TickedPlanetscaleWatch: {},
	CompletedGcpLogVolume: { key: Schema.String, result: Schema.Result(LogVolume, LoadFailure) },
	CompletedGcpFleet: { key: Schema.String, result: Schema.Result(Schema.Array(FleetRead), LoadFailure) },
	CompletedGcpInventory: result(GcpResourcesResponse),
	GotWorkloadFilterMessage: { message: ToggleGroup.Message },
	GotGcpMenuMessage: { id: GcpConnectorId, message: Menu.Message },
	GotGcpDisconnectDialogMessage: { message: Dialog.Message },
	ConfirmedGcpDisconnect: {},
	/** A Google Cloud source's Delete: opens the removal dialog for its connector. */
	ClickedGcpDisconnect: { id: Schema.String },
	CompletedGcpDisconnect: {
		id: GcpConnectorId,
		cleanupScript: Schema.NullOr(Schema.String),
		failure: Schema.NullOr(LoadFailure),
	},
	CompletedReadGcpRemoved: { removed: Schema.Array(RemovedConnector) },
	CompletedWriteGcpRemoved: {},
	ClickedDismissCleanup: { id: Schema.String },
	GotGcpDismissDialogMessage: { message: Dialog.Message },
	ConfirmedDismissCleanup: {},
	GotGcpCopyMessage: { id: Schema.String, message: CopyButton.Message },
	CompletedGcpScripts: { key: Schema.String, result: Schema.Result(V2GcpSetupScripts, LoadFailure) },
	ClickedGcpScriptToggle: {},
	ClickedGcpScriptRetry: {},
	ClickedGcpConfigure: { target: ConfigureTarget },
	/** Cancel, Close and Done: the wizard unmounts at once. */
	ClosedGcpConfigure: {},
	GotGcpConfigureDialogMessage: { message: Dialog.Message },
	GotGcpScopeTypeMessage: { message: ToggleGroup.Message },
	GotGcpScopeFieldMessage: { field: Schema.Literals(["scopeId", "hostProjectId"]), message: Field.Message },
	/** The scope step's form submit (Continue or Enter). */
	SubmittedGcpScope: {},
	SubmittedGcpCreate: {},
	ClickedGcpConfigureBack: {},
	ToggledGcpCollect: { capability: Capability },
	ClickedGcpLogFilter: {},
	GotGcpFilterModeMessage: { message: Select.Message },
	ClickedGcpForwardOutput: {},
	ClickedGcpUseOpenTelemetry: {},
	ToggledGcpRuntime: { runtime: GcpLogRuntime },
	CompletedGcpCreate: {
		opens: Schema.Number,
		connector: Schema.NullOr(V2GcpConnector),
		failure: Schema.NullOr(LoadFailure),
	},
	/** The data step's Continue, Save or "Save and continue". */
	ClickedGcpChooseApply: {},
	GotGcpConfirmDialogMessage: { message: Dialog.Message },
	ConfirmedGcpSave: {},
	CompletedGcpUpdate: {
		opens: Schema.Number,
		id: GcpConnectorId,
		flags: GcpFlags,
		failure: Schema.NullOr(LoadFailure),
	},
	ClickedGcpRunEdit: {},
	CompletedGcpConfigureScripts: {
		key: Schema.String,
		result: Schema.Result(V2GcpSetupScripts, LoadFailure),
	},
	ClickedGcpConfigureScriptRetry: {},
	ClickedGcpScriptExpand: {},
	/** The Method step: a row, or the code flavour under it. */
	ClickedGcpMethod: { method: SetupMethod },
	GotGcpFlavourMessage: { message: ToggleGroup.Message },
	ClickedGcpMethodContinue: {},
	ClickedGcpManualStep: { title: Schema.String, firstTitle: Schema.NullOr(Schema.String) },
	ClickedGcpCopyPrompt: { prompt: Schema.String },
	CompletedGcpPromptCopy: { isCopied: Schema.Boolean },
	ClickedGcpPromptBack: {},
	ClickedGcpConfirmRemoval: {},
	CompletedGcpConfirmRemoval: { failure: Schema.NullOr(LoadFailure) },
	/** The status poll: 10 s while a connection settles, else every minute (`useIntervalRefresh`). */
	TickedGcpRefresh: {},
	ReceivedConnectMessage: {
		provider: ConnectProvider,
		status: Schema.String,
		message: Schema.NullOr(Schema.String),
	},
	/** The provider return this page was opened with, finished (`null`: there was none). */
	CompletedOAuthReturn: { outcome: Schema.NullOr(OAuthReturnOutcome) },
})
export type Message = typeof Message.Type
