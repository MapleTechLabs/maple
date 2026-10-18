import {
	BillingCustomer,
	CloudflareIntegrationStatus,
	GithubIntegrationStatus,
	HazelIntegrationStatus,
	RailwayIntegrationStatus,
	VcsRepositoryId,
} from "@maple/domain/http"
import {
	V2ChatConnectorList,
	V2GcpIntegration,
	V2PlanetScaleDatabaseList,
	V2PlanetScaleIntegration,
	V2ScrapeTarget,
} from "@maple/domain/http/v2"
import { ChatWorkspaceId } from "@maple/domain/primitives"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/load-failure"
import * as Dialog from "../../ui/dialog"
import * as Popover from "../../ui/popover"
import { ConnectProvider } from "./connect"

export const StatusName = Schema.Literals([
	"cloudflare",
	"railway",
	"planetscale",
	"planetscaleDatabases",
	"gcp",
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
	CompletedLoadHazel: result(HazelIntegrationStatus),
	CompletedLoadGithub: result(GithubIntegrationStatus),
	CompletedLoadChat: result(V2ChatConnectorList),
	CompletedLoadScrapeTargets: result(Schema.Array(V2ScrapeTarget)),
	CompletedLoadCustomer: result(BillingCustomer),
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
	ReceivedConnectMessage: {
		provider: ConnectProvider,
		status: Schema.String,
		message: Schema.NullOr(Schema.String),
	},
})
export type Message = typeof Message.Type
