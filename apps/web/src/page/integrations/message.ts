import * as Policy from "@maple/domain/policy"
import { DataSourceKind } from "@maple/domain/data-sources"
import { HubFilter } from "./catalog"
import {
	BillingCustomer,
	CloudflareIntegrationStatus,
	FleetIntegrationStatus,
	GithubIntegrationStatus,
	GithubInstallationSelection,
	LinearIntegrationStatus,
	RailwayIntegrationStatus,
	SearchConsoleIntegrationStatus,
	SupabaseIntegrationStatus,
	VercelIntegrationStatus,
} from "@maple/domain/http"
import {
	V2AwsIntegration,
	V2ChatConnectorList,
	V2DataSource,
	V2GcpIntegration,
	V2PlanetScaleDatabaseList,
	V2PlanetScaleIntegration,
	V2ScrapeTarget,
} from "@maple/domain/http/v2"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import { ConnectProvider } from "./connect"
import { OAuthReturnOutcome } from "./oauth-return"
import { SupabaseMessage } from "../infra-integrations/supabase/integration/supabase"
import { RailwayMessage } from "../infra-integrations/railway/integration/railway"
import { SearchConsoleMessage } from "./search-console"
import { ChatMessage } from "./chat"
import { GcpMessage } from "../infra-integrations/gcp/integration/gcp"
import { VercelMessage } from "../infra-integrations/vercel/integration/vercel"
import { LinearMessage } from "./linear"
import { FleetMessage } from "./fleet/fleet"
import { GithubMessage } from "./github"
import { PrometheusMessage } from "./prometheus"
import { AwsMessage } from "../infra-integrations/aws/integration/aws"
import { PlanetscaleMessage } from "../infra-integrations/planetscale/integration/planetscale"
import { CloudflareMessage } from "../infra-integrations/cloudflare/integration/cloudflare"

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
	GotAwsMessage: { message: AwsMessage },
	/** A message for the Google Cloud module, its configure wizard's among them. */
	GotGcpMessage: { message: GcpMessage },
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
