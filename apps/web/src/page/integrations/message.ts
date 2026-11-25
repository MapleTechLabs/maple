import * as Policy from "@maple/domain/policy"
import { DataSourceKind } from "@maple/domain/data-sources"
import { HubFilter } from "./catalog"
import {
	BillingCustomer,
	CloudflareIntegrationStatus,
	FleetIntegrationStatus,
	GcpResourcesResponse,
	GithubIntegrationStatus,
	GithubInstallationSelection,
	LinearIntegrationStatus,
	RailwayIntegrationStatus,
	SearchConsoleIntegrationStatus,
	SupabaseIntegrationStatus,
	VercelIntegrationStatus,
} from "@maple/domain/http"
import {
	V2AwsConnection,
	V2AwsIntegration,
	V2AwsIngest,
	V2AwsSetup,
	V2ChatConnectorList,
	V2DataSource,
	V2GcpConnector,
	V2GcpIntegration,
	V2GcpSetupScripts,
	V2PlanetScaleDatabaseList,
	V2PlanetScaleIntegration,
	V2ScrapeTarget,
} from "@maple/domain/http/v2"
import {
	AwsConnectionId,
	AwsMetricNamespace,
	AwsModule,
	GcpConnectorId,
	GcpLogRuntime,
} from "@maple/primitives"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as Menu from "@maple/views/ui/menu"
import * as Select from "@maple/views/ui/select"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import { ConnectProvider } from "./connect"
import { OAuthReturnOutcome } from "./oauth-return"
import { FleetRead } from "../infra-integrations/gcp/data"
import { SupabaseMessage } from "../infra-integrations/supabase/integration/supabase"
import { RailwayMessage } from "../infra-integrations/railway/integration/railway"
import { SearchConsoleMessage } from "./search-console"
import { ChatMessage } from "./chat"
import { Capability, GcpFlags, SetupMethod } from "../infra-integrations/gcp/integration/gcp-configure-schema"
import {
	ConfigureTarget,
	LogVolume,
	RemovedConnector,
} from "../infra-integrations/gcp/integration/gcp-schema"
import { VercelMessage } from "../infra-integrations/vercel/integration/vercel"
import { LinearMessage } from "./linear"
import { FleetMessage } from "./fleet/fleet"
import { GithubMessage } from "./github"
import { PrometheusMessage } from "./prometheus"
import { PlanetscaleMessage } from "../infra-integrations/planetscale/integration/planetscale"
import { CloudflareMessage } from "../infra-integrations/cloudflare/integration/cloudflare"
import {
	AwsRemovedStack,
	AwsSetupMethod,
	AwsSetupPart,
} from "../infra-integrations/aws/integration/aws-schema"

export const StatusName = Schema.Literals([
	"cloudflare",
	"railway",
	"vercel",
	"planetscale",
	"planetscaleDatabases",
	"gcp",
	"aws",
	"supabase",
	"linear",
	"github",
	"searchConsole",
	"fleet",
	"chat",
	"scrapeTargets",
	"dataSources",
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
	CompletedLoadVercel: result(VercelIntegrationStatus),
	CompletedLoadPlanetscale: result(V2PlanetScaleIntegration),
	CompletedLoadPlanetscaleDatabases: result(V2PlanetScaleDatabaseList),
	CompletedLoadGcp: result(V2GcpIntegration),
	CompletedLoadAws: result(V2AwsIntegration),
	CompletedLoadSupabase: result(SupabaseIntegrationStatus),
	CompletedLoadLinear: result(LinearIntegrationStatus),
	CompletedLoadGithub: result(GithubIntegrationStatus),
	CompletedLoadSearchConsole: result(SearchConsoleIntegrationStatus),
	CompletedLoadFleet: result(FleetIntegrationStatus),
	CompletedLoadChat: result(V2ChatConnectorList),
	CompletedLoadScrapeTargets: result(Schema.Array(V2ScrapeTarget)),
	CompletedLoadDataSources: result(Schema.Array(V2DataSource)),
	/** A filter chip above the hub's list. */
	SelectedFilter: { filter: HubFilter },
	/** A data source row, or a "Query in place" card (Settings > Data sources). */
	ClickedDataSource: { source: Schema.NullOr(Schema.String), connect: Schema.NullOr(DataSourceKind) },
	CompletedLoadCustomer: result(BillingCustomer),
	/** `trackProduct("integration_connected")` was handed to the session SDK. */
	CompletedTrackConnected: {},
	/** `trackProduct("integration_disconnected")` was handed to the session SDK. */
	CompletedTrackDisconnected: {},
	/** The shared session read answered with its grants. */
	CompletedLoadSession: { grants: Schema.Array(Policy.PermissionName), hasDataSources: Schema.Boolean },
	/** A catalog row or card, or the header's back button. */
	ClickedIntegration: { integration: Schema.NullOr(Schema.String) },
	/** A connected data integration's hub row: its sources, where a failing one heads the list. */
	ClickedConnectedSources: { query: Schema.String },
	/** A settings nav tab. */
	ClickedSettingsTab: { tab: Schema.String },
	/** The chat callback toast went out; the return params are stripped next (a replace). */
	CompletedChatToast: {},
	/** The header or card Connect button: a new popup attempt for the page's provider. */
	ClickedConnect: {},
	/**
	 * Opens the GitHub App install page, not authorization: the picker's "Install on another
	 * GitHub account", and "Change repos on GitHub" (an installed account gets its settings).
	 */
	ClickedOpenGithubInstallPage: {},
	SucceededStartConnect: { attempt: Schema.Number },
	FailedStartConnect: { attempt: Schema.Number, title: Schema.String, description: Schema.String },
	/** The authorize URL arrived but the popup was gone and could not be reopened. */
	BlockedConnectPopup: { attempt: Schema.Number },
	/** Every 3 s while a polling provider's popup is out. */
	PolledConnect: { attempt: Schema.Number },
	ClosedConnectPopup: { attempt: Schema.Number },
	EndedConnectGrace: { attempt: Schema.Number },
	/** The callback page's `postMessage` (`maple:integration:<provider>`). */
	ClickedRetryStatus: { name: StatusName },
	/** The hub's one Try again: re-reads every status that failed. */
	ClickedRetryFailedStatuses: {},
	ClickedDisconnect: {},
	GotDisconnectDialogMessage: { message: Dialog.Message },
	ConfirmedDisconnect: {},
	CompletedDisconnect: { integration: Schema.String, failure: Schema.NullOr(LoadFailure) },
	/** A message for the Railway module (`provider-modules.ts`). */
	GotRailwayMessage: { message: RailwayMessage },
	/** A message for the Supabase module. */
	GotSupabaseMessage: { message: SupabaseMessage },
	GotSearchConsoleMessage: { message: SearchConsoleMessage },
	GotChatMessage: { message: ChatMessage },
	GotLinearMessage: { message: LinearMessage },
	/** A message for the Fleet module (`provider-modules.ts`). */
	GotFleetMessage: { message: FleetMessage },
	GotVercelMessage: { message: VercelMessage },
	GotPlanetscaleMessage: { message: PlanetscaleMessage },
	GotCloudflareMessage: { message: CloudflareMessage },
	GotGithubMessage: { message: GithubMessage },
	/** A message for the scrape-target module (Prometheus and WarpStream). */
	GotPrometheusMessage: { message: PrometheusMessage },
	GotAwsAccountIdMessage: { message: Field.Message },
	SubmittedAwsAccount: {},
	SucceededAwsCreate: { connection: V2AwsConnection },
	FailedAwsCreate: { error: Schema.String },
	ClickedAwsAdd: {},
	ClickedAwsAddCancel: {},
	ClickedAwsSetup: { id: AwsConnectionId },
	ClickedAwsSetupClose: {},
	CompletedLoadAwsSetup: result(V2AwsSetup),
	CompletedLoadAwsIngest: { id: AwsConnectionId, ...result(V2AwsIngest) },
	ClickedAwsSetupMethod: { part: AwsSetupPart, method: AwsSetupMethod },
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
	ToggledAwsRegion: { id: AwsConnectionId, region: Schema.String },
	ToggledAwsNamespace: { id: AwsConnectionId, namespace: AwsMetricNamespace },
	SubmittedAwsMetrics: { id: AwsConnectionId },
	/** `id`: the connection the save was for, which the editor may have moved on from. */
	CompletedAwsMetricStream: {
		id: AwsConnectionId,
		connection: Schema.NullOr(V2AwsConnection),
		error: Schema.NullOr(Schema.String),
	},
	ToggledAwsModule: { id: AwsConnectionId, module: AwsModule },
	CompletedAwsModules: {
		id: AwsConnectionId,
		connection: Schema.NullOr(V2AwsConnection),
		error: Schema.NullOr(Schema.String),
	},
	/** The connect flow's opt-in for a module on the account about to be connected. */
	ToggledAwsNewModule: { module: AwsModule },
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
	SubmittedGcpCreate: {},
	ToggledGcpCollect: { capability: Capability },
	/** A connection's feature switch: Edit data opens with that change drafted, to save from there. */
	ToggledGcpFeature: { id: Schema.String, capability: Capability },
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
	/** The status poll: 10 s while a connection settles, else every minute. */
	TickedGcpRefresh: {},
	ReceivedConnectMessage: {
		provider: ConnectProvider,
		status: Schema.String,
		message: Schema.NullOr(Schema.String),
		github: Schema.optionalKey(GithubInstallationSelection),
	},
	/** Another tab finished a return whose popup lost its opener (`RELAY_CHANNEL`). */
	ReceivedConnectRelay: {
		provider: ConnectProvider,
		status: Schema.String,
		message: Schema.String,
		github: Schema.optionalKey(GithubInstallationSelection),
	},
	/** The provider return this page was opened with, finished (`null`: there was none). */
	CompletedOAuthReturn: { outcome: Schema.NullOr(OAuthReturnOutcome) },
})
export type Message = typeof Message.Type
