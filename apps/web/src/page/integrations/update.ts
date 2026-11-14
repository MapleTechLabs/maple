import * as Policy from "@maple/domain/policy"
import { Option, Result, Array as Arr } from "effect"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import { AppRoute, hrefOf } from "../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import * as Dialog from "@maple/views/ui/dialog"
import { integrationOfSearch } from "./catalog"
import { chatCallbackOf } from "./chat-callback"
import { initConnect } from "./connect"
import { Disconnect, DISCONNECTS } from "./disconnect"
import { initGithubCard } from "./github"
import * as Github from "./update-github"
import { initPrometheusCard } from "./prometheus"
import { initGcpCard } from "../infra-integrations/gcp/integration/gcp"
import { initAwsCard } from "../infra-integrations/aws/integration/aws"
import * as Aws from "../infra-integrations/aws/integration/update-aws"
import * as Gcp from "../infra-integrations/gcp/integration/update-gcp"
import * as Configure from "../infra-integrations/gcp/integration/update-gcp-configure"
import * as Prometheus from "./update-prometheus"
import { isMultiAccount } from "../infra-integrations/cloudflare/integration/view-cloudflare"
import * as Connect from "./update-connect"
import { isClerkAuthEnabled } from "../../platform/auth-mode"
import {
	CompleteOAuthReturn,
	LoadCustomer,
	LoadSession,
	ReadClock,
	StripChatParams,
	TrackDisconnected,
} from "./command"
import type { OAuthReturnOutcome } from "./oauth-return"
import { chain, requestStatus, statusNamesOf } from "./update-status"
import {
	CHAT_PROVIDER,
	CLOUDFLARE_PROVIDER,
	everyProvider,
	PLANETSCALE_PROVIDER,
	PROVIDER_MODULES,
	providerModuleOf,
	RAILWAY_PROVIDER,
	SEARCH_CONSOLE_PROVIDER,
	SUPABASE_PROVIDER,
	VERCEL_PROVIDER,
	withDisconnectDialog,
} from "./provider-modules"
import { Message } from "./message"
import type { Model, Statuses } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]

const customerKey = (context: PageContext) => requestKey(context.orgId, "billing.getCustomer", {})

const requestCustomer = (model: Model, context: PageContext): Return => {
	const key = customerKey(context)
	return Option.match(Keyed.request(model.customer, key, "Load"), {
		onNone: () => ({ model }),
		onSome: (customer) => ({
			model: { ...model, customer },
			commands: [LoadCustomer({ key, orgId: context.orgId })],
		}),
	})
}

/**
 * The chat OAuth return: the toast now, the param strip after (`StripChatParams`). On entry (the
 * callback's full-page load) no toast shows: `withToast: false` runs only the strip.
 */
const handleChatCallback = (model: Model, withToast: boolean): Return => {
	const callback = chatCallbackOf(model.search)
	return callback === null
		? { model }
		: !withToast
			? navigateTo(model, hrefOfSearch(callback.next), true)
			: {
					model,
					commands: [StripChatParams()],
					outMessage: PageOutMessage.RequestedToast({
						type: callback.type,
						title: callback.title,
						description: "",
					}),
				}
}

/** A chat return's outcome, as the `chat*` search params `chatCallbackOf` toasts and strips. */
const chatSearchOf = (outcome: OAuthReturnOutcome, chat: NonNullable<OAuthReturnOutcome["chat"]>): Search => {
	const ok = outcome.status === "success"
	const integration = outcome.connector === null ? {} : { integration: `chat-${outcome.connector}` }
	const reason = ok || chat.reason === null ? {} : { chat_reason: chat.reason }
	if (chat.kind === "workspace") {
		const name = chat.name === null ? {} : { chat_workspace: chat.name }
		return { ...integration, chat: ok ? "connected" : "error", ...name, ...reason }
	}
	const name = chat.name === null ? {} : { chat_identity_name: chat.name }
	return { ...integration, chat_identity: ok ? "linked" : "error", ...name, ...reason }
}

/**
 * The finished provider return: a chat flow reports through its search params and re-reads the
 * connectors (the entry read raced the install), a popup whose opener took the outcome waits to
 * close, and anything else reports here.
 */
const completedOAuthReturn = (
	model: Model,
	context: PageContext,
	outcome: OAuthReturnOutcome | null,
): Return => {
	if (outcome === null) return { model }
	const chat = outcome.chat
	if (chat !== null)
		return chain(model, [
			(next) => requestStatus(next, context, "chat", "Supersede"),
			(next) => navigateTo(next, hrefOfSearch(chatSearchOf(outcome, chat)), true),
		])
	if (outcome.provider === null || (outcome.isHandedOff && outcome.status === "success")) return { model }
	return Connect.receivedCallback(
		model,
		context,
		outcome.provider,
		outcome.status,
		outcome.message,
		outcome.github,
	)
}

const navigateTo = (model: Model, url: string, isReplace: boolean): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url, isReplace }),
})

export const hrefOfSearch = (search: Search) => hrefOf(AppRoute.Integrations({ search }))

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		nowMs: 0,
		statuses: {
			cloudflare: Keyed.idle(),
			railway: Keyed.idle(),
			vercel: Keyed.idle(),
			planetscale: Keyed.idle(),
			planetscaleDatabases: Keyed.idle(),
			gcp: Keyed.idle(),
			aws: Keyed.idle(),
			supabase: Keyed.idle(),
			linear: Keyed.idle(),
			github: Keyed.idle(),
			searchConsole: Keyed.idle(),
			chat: Keyed.idle(),
			scrapeTargets: Keyed.idle(),
			dataSources: Keyed.idle(),
		},
		customer: Keyed.idle(),
		grants: isClerkAuthEnabled ? [] : Policy.allPermissions,
		hasDataSources: !isClerkAuthEnabled,
		filter: "all",
		connect: initConnect(),
		disconnect: { dialog: Dialog.init("integration-disconnect", "alert-dialog"), isPending: false },
		chatCard: CHAT_PROVIDER.initial(),
		githubCard: initGithubCard(),
		cloudflareCard: CLOUDFLARE_PROVIDER.initial(),
		prometheusCard: initPrometheusCard(),
		planetscaleCard: PLANETSCALE_PROVIDER.initial(),
		gcpCard: initGcpCard(),
		awsCard: initAwsCard(),
		railwayCard: RAILWAY_PROVIDER.initial(),
		vercelCard: VERCEL_PROVIDER.initial(),
		supabaseCard: SUPABASE_PROVIDER.initial(),
		searchConsoleCard: SEARCH_CONSOLE_PROVIDER.initial(),
	}
	const loaded = chain(model, [
		...Arr.map(
			statusNamesOf(model),
			(name) => (next: Model) => requestStatus(next, context, name, "Load"),
		),
		(next: Model) => requestCustomer(next, context),
		(next: Model) => enterIntegration(next, context),
		(next: Model) => handleChatCallback(next, false),
	])
	const session = isClerkAuthEnabled ? [LoadSession()] : []
	return {
		...loaded,
		commands: [ReadClock(), CompleteOAuthReturn(), ...session, ...(loaded.commands ?? [])],
	}
}

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return =>
	hrefOfSearch(model.search) === hrefOfSearch(route.search)
		? { model }
		: chain({ ...model, search: route.search }, [
				(next) => enterIntegration(next, context),
				(next) => handleChatCallback(next, true),
			])

/** The reads an integration's card mounts (Cloudflare's usage, PlanetScale's watch clock). */
const enterIntegration = (model: Model, context: PageContext): Return => {
	const integration = integrationOfSearch(model.search.integration)
	if (integration === "aws") return Aws.enterAws(model, context)
	if (integration === "gcp")
		return chain(model, [(next) => Gcp.enterGcp(next, context), (next) => Gcp.requestBand(next, context)])
	return providerModuleOf(integration)?.onEnter(model, context) ?? { model }
}

/** The GCP band's reads wait on the status and the clock. */
const gcpBand = (model: Model, context: PageContext): Return =>
	integrationOfSearch(model.search.integration) === "gcp" ? Gcp.requestBand(model, context) : { model }

export const contextChanged = (model: Model): Return => ({ model })

const accepted = (model: Model, statuses: Statuses): Return => ({ model: { ...model, statuses } })

export const update = (model: Model, message: Message, context: PageContext): Return => {
	const s = model.statuses
	return Message.match<Return>(message, {
		CompletedReadClock: ({ nowMs }) =>
			chain({ ...model, nowMs }, [
				(next) => gcpBand(next, context),
				(next) => everyProvider(next, (provider) => (each) => provider.onClock(each, context)),
			]),
		CompletedLoadCloudflare: ({ key, result }) =>
			accepted(model, { ...s, cloudflare: Keyed.accept(s.cloudflare, key, result) }),
		CompletedLoadRailway: ({ key, result }) =>
			RAILWAY_PROVIDER.onStatus(
				accepted(model, { ...s, railway: Keyed.accept(s.railway, key, result) }).model,
				context,
				{ isCurrent: s.railway.key === key, previous: s.railway },
			),
		CompletedLoadVercel: ({ key, result }) =>
			accepted(model, { ...s, vercel: Keyed.accept(s.vercel, key, result) }),
		CompletedLoadPlanetscale: ({ key, result }) =>
			PLANETSCALE_PROVIDER.onStatus(
				accepted(model, { ...s, planetscale: Keyed.accept(s.planetscale, key, result) }).model,
				context,
				{ isCurrent: s.planetscale.key === key, previous: s.planetscale },
			),
		CompletedLoadPlanetscaleDatabases: ({ key, result }) =>
			accepted(model, {
				...s,
				planetscaleDatabases: Keyed.accept(s.planetscaleDatabases, key, result),
			}),
		CompletedLoadGcp: ({ key, result }) => {
			const read = accepted(model, { ...s, gcp: Keyed.accept(s.gcp, key, result) }).model
			const arrived =
				s.gcp.key === key && Result.isSuccess(result) ? Configure.statusArrived(read).model : read
			return gcpBand(arrived, context)
		},
		CompletedLoadAws: ({ key, result }) =>
			Aws.statusArrived(
				accepted(model, { ...s, aws: Keyed.accept(s.aws, key, result) }).model,
				context,
				Aws.connectionsOf(model),
			),
		CompletedLoadSupabase: ({ key, result }) =>
			SUPABASE_PROVIDER.onStatus(
				accepted(model, { ...s, supabase: Keyed.accept(s.supabase, key, result) }).model,
				context,
				{ isCurrent: s.supabase.key === key, previous: s.supabase },
			),
		GotRailwayMessage: ({ message: child }) => RAILWAY_PROVIDER.update(model, child, context),
		GotSupabaseMessage: ({ message: child }) => SUPABASE_PROVIDER.update(model, child, context),
		CompletedLoadLinear: ({ key, result }) =>
			accepted(model, { ...s, linear: Keyed.accept(s.linear, key, result) }),
		CompletedLoadGithub: ({ key, result }) =>
			accepted(model, { ...s, github: Keyed.accept(s.github, key, result) }),
		CompletedLoadSearchConsole: ({ key, result }) =>
			SEARCH_CONSOLE_PROVIDER.onStatus(
				accepted(model, { ...s, searchConsole: Keyed.accept(s.searchConsole, key, result) }).model,
				context,
				{ isCurrent: s.searchConsole.key === key, previous: s.searchConsole },
			),
		GotSearchConsoleMessage: ({ message: child }) =>
			SEARCH_CONSOLE_PROVIDER.update(model, child, context),
		GotChatMessage: ({ message: child }) => CHAT_PROVIDER.update(model, child, context),
		GotVercelMessage: ({ message: child }) => VERCEL_PROVIDER.update(model, child, context),
		GotPlanetscaleMessage: ({ message: child }) => PLANETSCALE_PROVIDER.update(model, child, context),
		GotCloudflareMessage: ({ message: child }) => CLOUDFLARE_PROVIDER.update(model, child, context),
		CompletedLoadChat: ({ key, result }) =>
			accepted(model, { ...s, chat: Keyed.accept(s.chat, key, result) }),
		CompletedLoadScrapeTargets: ({ key, result }) =>
			accepted(model, { ...s, scrapeTargets: Keyed.accept(s.scrapeTargets, key, result) }),
		CompletedLoadCustomer: ({ key, result }) => ({
			model: { ...model, customer: Keyed.accept(model.customer, key, result) },
		}),
		CompletedLoadSession: ({ grants, hasDataSources }) => {
			const next = { ...model, grants, hasDataSources }
			return hasDataSources ? requestStatus(next, context, "dataSources", "Load") : { model: next }
		},
		CompletedLoadDataSources: ({ key, result }) =>
			accepted(model, { ...s, dataSources: Keyed.accept(s.dataSources, key, result) }),
		SelectedFilter: ({ filter }) => ({ model: { ...model, filter } }),
		ClickedDataSource: ({ source, connect }) =>
			navigateTo(
				model,
				hrefOf(
					AppRoute.Settings({
						search: {
							tab: "data-sources",
							source: source ?? undefined,
							connect: connect ?? undefined,
						},
					}),
				),
				false,
			),
		CompletedTrackConnected: () => ({ model }),
		CompletedTrackDisconnected: () => ({ model }),
		ClickedIntegration: ({ integration }) =>
			navigateTo(model, hrefOfSearch(integration === null ? {} : { integration }), false),
		ClickedSettingsTab: ({ tab }) => navigateTo(model, `/settings?tab=${encodeURIComponent(tab)}`, false),
		CompletedChatToast: () => {
			const callback = chatCallbackOf(model.search)
			return callback === null ? { model } : navigateTo(model, hrefOfSearch(callback.next), true)
		},
		ClickedConnect: () => Connect.clickedConnect(model, context),
		ClickedOpenGithubInstallPage: () => Connect.clickedConnect(model, context, "install"),
		ClickedSelectGithubInstallation: ({ installationId }) =>
			Github.clickedInstallation(model, installationId),
		CompletedSelectGithubInstallation: ({ state, installationId, failure }) =>
			Github.completedInstallation(model, context, state, installationId, failure),
		ClickedTarget: ({ id }) => Prometheus.clickedTarget(model, context, id),
		CompletedFetchChecks: ({ key, result }) => ({
			model: {
				...model,
				prometheusCard: {
					...model.prometheusCard,
					checks: Keyed.accept(model.prometheusCard.checks, key, result),
				},
			},
		}),
		TickedTargetsRefresh: () => requestStatus(model, context, "scrapeTargets", "Refresh"),
		TickedChecksRefresh: () => Prometheus.requestChecks(model, context, "Refresh"),
		ClickedProbe: ({ id }) => Prometheus.clickedProbe(model, id),
		CompletedProbe: ({ id, failure, success, error }) =>
			Prometheus.completedProbe(model, context, id, failure, success, error),
		ClickedToggleTarget: ({ id }) => Prometheus.clickedToggle(model, id),
		CompletedToggle: ({ id, failure }) => Prometheus.completedToggle(model, context, id, failure),
		ClickedEditTarget: ({ id }) => Prometheus.clickedEdit(model, id),
		ClickedDeleteTarget: ({ id }) => Prometheus.clickedDelete(model, id),
		GotTargetMenuMessage: ({ id, message: child }) => Prometheus.gotTargetMenu(model, id, child),
		GotFormDialogMessage: ({ message: child }) => Prometheus.gotFormDialog(model, child),
		GotFormFieldMessage: ({ field, message: child }) => Prometheus.gotFormField(model, field, child),
		GotAuthSelectMessage: ({ message: child }) => Prometheus.gotAuthSelect(model, child),
		SubmittedTargetForm: () => Prometheus.submittedForm(model),
		CompletedSave: ({ isEdit, id, failure }) =>
			Prometheus.completedSave(model, context, isEdit, id, failure),
		GotTargetDeleteDialogMessage: ({ message: child }) => Prometheus.gotDeleteDialog(model, child),
		ConfirmedTargetDelete: () => Prometheus.confirmedDelete(model),
		CompletedTargetDelete: ({ id, failure }) => Prometheus.completedDelete(model, context, id, failure),
		GotAwsAccountIdMessage: ({ message: child }) => Aws.gotAccountId(model, child),
		SubmittedAwsAccount: () => Aws.submittedAccount(model),
		SucceededAwsCreate: ({ connection }) => Aws.succeededCreate(model, context, connection),
		FailedAwsCreate: ({ error }) => Aws.failedCreate(model, error),
		ClickedAwsAdd: () => Aws.setAdding(model, true),
		ClickedAwsAddCancel: () => Aws.setAdding(model, false),
		ClickedAwsSetup: ({ id }) => Aws.openSetup(model, context, id),
		ClickedAwsSetupClose: () => Aws.closeSetup(model),
		CompletedLoadAwsSetup: ({ key, result }) => Aws.completedLoadSetup(model, key, result),
		CompletedLoadAwsIngest: ({ id, key, result }) => Aws.completedIngest(model, id, key, result),
		ClickedAwsSetupMethod: ({ part, method }) => Aws.setMethod(model, part, method),
		ClickedAwsCheck: ({ id }) => Aws.clickedCheck(model, id),
		TickedAwsPending: () => Aws.tickedPending(model),
		TickedAwsWatch: () => Aws.tickedWatch(model, context),
		CompletedAwsCheck: ({ id, quiet, connection, failure }) =>
			Aws.completedCheck(model, context, id, quiet, connection, failure),
		GotAwsCopyMessage: ({ id, message: child }) => Aws.gotCopy(model, id, child),
		ClickedAwsDisconnect: ({ id }) => Aws.clickedDisconnect(model, id),
		GotAwsDisconnectDialogMessage: ({ message: child }) => Aws.gotDisconnectDialog(model, child),
		ConfirmedAwsDisconnect: () => Aws.confirmedDisconnect(model),
		CompletedAwsDisconnect: ({ id, removed, error }) =>
			Aws.completedDisconnect(model, context, id, removed, error),
		DismissedAwsRemoved: ({ connectionId }) => Aws.dismissedRemoved(model, context, connectionId),
		CompletedReadAwsRemoved: ({ removed }) => Aws.completedReadRemoved(model, removed),
		CompletedWriteAwsRemoved: () => ({ model }),
		ClickedAwsMetrics: ({ id }) => Aws.clickedMetrics(model, id),
		ClickedAwsMetricsCancel: () => Aws.cancelledMetrics(model),
		ToggledAwsRegion: ({ id, region }) => Aws.toggledRegion(model, id, region),
		ToggledAwsNamespace: ({ id, namespace }) => Aws.toggledNamespace(model, id, namespace),
		SubmittedAwsMetrics: ({ id }) => Aws.submittedMetrics(model, id),
		CompletedAwsMetricStream: ({ id, connection, error }) =>
			Aws.completedMetricStream(model, context, id, connection, error),
		ToggledAwsModule: ({ id, module }) => Aws.toggledModule(model, id, module),
		CompletedAwsModules: ({ id, connection, error }) =>
			Aws.completedModules(model, context, id, connection, error),
		ToggledAwsNewModule: ({ module }) => Aws.toggledNewModule(model, module),
		CompletedGcpLogVolume: ({ key, result }) =>
			Gcp.updateGcpCard(model, { logVolume: Keyed.accept(model.gcpCard.logVolume, key, result) }),
		CompletedGcpFleet: ({ key, result }) =>
			Gcp.updateGcpCard(model, { fleet: Keyed.accept(model.gcpCard.fleet, key, result) }),
		CompletedGcpInventory: ({ key, result }) =>
			Gcp.updateGcpCard(model, { inventory: Keyed.accept(model.gcpCard.inventory, key, result) }),
		GotWorkloadFilterMessage: ({ message: child }) => Gcp.gotWorkloadFilter(model, child),
		GotGcpMenuMessage: ({ id, message: child }) =>
			Gcp.gotMenu(model, context, id, child, (next, target) => Configure.openConfigure(next, target)),
		CompletedGcpScripts: ({ key, result }) =>
			Gcp.updateGcpCard(model, { scripts: Keyed.accept(model.gcpCard.scripts, key, result) }),
		ClickedGcpScriptToggle: () =>
			Gcp.updateGcpCard(model, { isScriptShown: !model.gcpCard.isScriptShown }),
		ClickedGcpScriptRetry: () => Gcp.retriedScripts(model, context),
		GotGcpDisconnectDialogMessage: ({ message: child }) => Gcp.gotDisconnectDialog(model, child),
		ConfirmedGcpDisconnect: () => Gcp.confirmedDisconnect(model),
		ClickedGcpDisconnect: ({ id }) => Gcp.clickedDisconnect(model, context, id),
		CompletedGcpDisconnect: ({ id, cleanupScript, failure }) =>
			Gcp.completedDisconnect(model, context, id, cleanupScript, failure),
		CompletedReadGcpRemoved: ({ removed }) => Gcp.updateGcpCard(model, { removed }),
		CompletedWriteGcpRemoved: () => ({ model }),
		ClickedDismissCleanup: ({ id }) => Gcp.clickedDismiss(model, id),
		GotGcpDismissDialogMessage: ({ message: child }) => Gcp.gotDismissDialog(model, child),
		ConfirmedDismissCleanup: () => Gcp.confirmedDismiss(model, context),
		GotGcpCopyMessage: ({ id, message: child }) => Gcp.gotCopy(model, id, child),
		ClickedGcpConfigure: ({ target }) => Configure.openConfigure(model, target),
		ClosedGcpConfigure: () => Configure.closedConfigure(model),
		GotGcpConfigureDialogMessage: ({ message: child }) => Configure.gotConfigureDialog(model, child),
		GotGcpScopeTypeMessage: ({ message: child }) => Configure.gotScopeType(model, child),
		GotGcpScopeFieldMessage: ({ field, message: child }) => Configure.gotScopeField(model, field, child),
		SubmittedGcpCreate: () => Configure.submittedCreate(model),
		ToggledGcpCollect: ({ capability }) => Configure.toggledCollect(model, capability),
		ClickedGcpLogFilter: () => Configure.clickedLogFilter(model),
		GotGcpFilterModeMessage: ({ message: child }) => Configure.gotFilterMode(model, context, child),
		ClickedGcpForwardOutput: () => Configure.clickedForwardOutput(model, context),
		ClickedGcpUseOpenTelemetry: () => Configure.clickedUseOpenTelemetry(model, context),
		ToggledGcpRuntime: ({ runtime }) => Configure.toggledRuntime(model, context, runtime),
		CompletedGcpCreate: ({ opens, connector, failure }) =>
			Configure.completedCreate(model, context, opens, connector, failure),
		ClickedGcpChooseApply: () => Configure.clickedChooseApply(model),
		GotGcpConfirmDialogMessage: ({ message: child }) => Configure.gotConfirmDialog(model, child),
		ConfirmedGcpSave: () => Configure.confirmedSave(model),
		CompletedGcpUpdate: ({ opens, flags, failure }) =>
			Configure.completedUpdate(model, context, opens, flags, failure),
		ClickedGcpRunEdit: () => Configure.clickedRunEdit(model),
		CompletedGcpConfigureScripts: ({ key, result }) => Configure.completedScripts(model, key, result),
		ClickedGcpConfigureScriptRetry: () => Configure.retriedScripts(model, context),
		ClickedGcpScriptExpand: () => Configure.clickedScriptExpand(model),
		ClickedGcpMethod: ({ method }) => Configure.clickedMethod(model, method),
		GotGcpFlavourMessage: ({ message: child }) => Configure.gotFlavour(model, child),
		ClickedGcpMethodContinue: () => Configure.clickedMethodContinue(model, context),
		ClickedGcpManualStep: ({ title, firstTitle }) =>
			Configure.clickedManualStep(model, title, firstTitle),
		ClickedGcpCopyPrompt: ({ prompt }) => Configure.clickedCopyPrompt(model, prompt),
		CompletedGcpPromptCopy: ({ isCopied }) => Configure.completedPromptCopy(model, isCopied),
		ClickedGcpPromptBack: () => Configure.clickedPromptBack(model),
		ClickedGcpConfirmRemoval: () => Configure.clickedConfirmRemoval(model),
		CompletedGcpConfirmRemoval: ({ failure }) =>
			Configure.completedConfirmRemoval(model, context, failure),
		TickedGcpRefresh: () => {
			const refreshed = requestStatus(model, context, "gcp", "Refresh")
			return { ...refreshed, commands: [...(refreshed.commands ?? []), ReadClock()] }
		},
		ClickedGithubRefresh: () => Github.clickedRefresh(model, context),
		CompletedGithubRefreshSpin: ({ version }) => Github.completedRefreshSpin(model, version),
		ToggledCiTraces: () => Github.toggledCiTraces(model),
		CompletedCiTraces: ({ enabled, failure }) =>
			Github.completedCiTraces(model, context, enabled, failure),
		TickedGithubPoll: () => requestStatus(model, context, "github", "Refresh"),
		EndedGithubForcePoll: ({ version }) => Github.endedForcePoll(model, version),
		ClickedRepoDelete: ({ repoId }) => Github.clickedRepoDelete(model, repoId),
		GotRepoDeleteDialogMessage: ({ message: child }) => Github.gotRepoDeleteDialog(model, child),
		ConfirmedRepoDelete: () => Github.confirmedRepoDelete(model),
		CompletedRepoDelete: ({ repoId, failure }) =>
			Github.completedRepoDelete(model, context, repoId, failure),
		GotBranchPopoverMessage: ({ repoId, message: child }) =>
			Github.gotBranchPopover(model, repoId, child),
		ChangedBranchQuery: ({ value }) => ({
			model: { ...model, githubCard: { ...model.githubCard, branchQuery: value } },
		}),
		ClickedBranch: ({ repoId, branch }) => Github.clickedBranch(model, repoId, branch),
		GotBranchDialogMessage: ({ message: child }) => Github.gotBranchDialog(model, child),
		ConfirmedBranch: () => Github.confirmedBranch(model),
		CompletedTrackedBranch: ({ repoId, branch, backfillQueued, failure }) =>
			Github.completedTrackedBranch(model, context, repoId, branch, backfillQueued, failure),
		SucceededStartConnect: ({ attempt }) => Connect.succeededStart(model, context, attempt),
		FailedStartConnect: ({ attempt, title, description }) =>
			Connect.failedStart(model, attempt, title, description),
		BlockedConnectPopup: ({ attempt }) => Connect.blockedPopup(model, context, attempt),
		PolledConnect: ({ attempt }) => Connect.polled(model, context, attempt),
		ClosedConnectPopup: ({ attempt }) => Connect.closedPopup(model, context, attempt),
		EndedConnectGrace: ({ attempt }) => Connect.endedGrace(model, attempt),
		ReceivedConnectMessage: ({ provider, status, message: text, github }) =>
			Connect.receivedCallback(model, context, provider, status, text, github),
		ReceivedConnectRelay: ({ provider, status, message: text, github }) =>
			Connect.receivedRelay(model, context, provider, status, text, github),
		CompletedOAuthReturn: ({ outcome }) => completedOAuthReturn(model, context, outcome),
		ClickedRetryStatus: ({ name }) => requestStatus(model, context, name, "Supersede"),
		ClickedRetryFailedStatuses: () =>
			chain(
				model,
				Arr.map(
					Arr.filter(statusNamesOf(model), (name) => {
						const tag = model.statuses[name].data._tag
						return tag === "Failure" || tag === "Stale"
					}),
					(name) => (next: Model) => requestStatus(next, context, name, "Supersede"),
				),
			),
		ClickedDisconnect: () => withDisconnectDialog(model, Dialog.open(model.disconnect.dialog)),
		GotDisconnectDialogMessage: ({ message: child }) =>
			model.disconnect.isPending ||
			Arr.some(PROVIDER_MODULES, (provider) => provider.isDisconnecting(model))
				? { model }
				: withDisconnectDialog(model, Dialog.update(model.disconnect.dialog, child)),
		ConfirmedDisconnect: () => {
			const integration = integrationOfSearch(model.search.integration)
			const ownDisconnect = providerModuleOf(integration)?.onConfirmDisconnect ?? null
			if (ownDisconnect !== null) return ownDisconnect(model, context)
			if (integration === null || model.disconnect.isPending) return { model }
			// The dialog stays open, its confirm pending, until `CompletedDisconnect` closes it.
			return {
				model: { ...model, disconnect: { ...model.disconnect, isPending: true } },
				commands: [
					Disconnect({
						integration:
							integration === "cloudflare" && isMultiAccount(model)
								? "cloudflare-multi"
								: integration,
					}),
				],
			}
		},
		CompletedDisconnect: ({ integration, failure }) => {
			const spec = DISCONNECTS.get(integration)
			const closed = withDisconnectDialog(
				{ ...model, disconnect: { ...model.disconnect, isPending: false } },
				Dialog.close(model.disconnect.dialog),
			)
			const settled = closed.model
			if (spec === undefined) return closed
			const toast = PageOutMessage.RequestedToast(
				failure === null
					? {
							type: spec.successType ?? "success",
							title: spec.success,
							description: spec.successDescription ?? "",
						}
					: { type: "error", title: spec.error, description: failure.message },
			)
			return chain(settled, [
				(next) => ({ model: next, commands: closed.commands, outMessage: toast }),
				(next) =>
					failure === null
						? {
								model: next,
								commands: [
									TrackDisconnected({
										provider:
											integration === "cloudflare-multi" ? "cloudflare" : integration,
									}),
								],
							}
						: { model: next },
				...Arr.map(
					failure === null ? spec.refresh : [],
					(name) => (next: Model) => requestStatus(next, context, name, "Supersede"),
				),
				(next) =>
					failure === null
						? (providerModuleOf(
								integrationOfSearch(
									integration === "cloudflare-multi" ? "cloudflare" : integration,
								),
							)?.onDisconnected(next, context) ?? { model: next })
						: { model: next },
			])
		},
	})
}
