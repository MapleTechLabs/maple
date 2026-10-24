import { Option, Result } from "effect"
import { Command as FoldkitCommand } from "foldkit"
import * as Keyed from "../../data/keyed"
import { requestKey } from "../../data/request-key"
import { AppRoute, hrefOf } from "../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import * as Dialog from "../../ui/dialog"
import { chatConnectorOf, integrationOfSearch } from "./catalog"
import { chatCallbackOf } from "./chat-callback"
import { initConnect } from "./connect"
import { Disconnect, DISCONNECTS } from "./disconnect"
import { initGithubCard } from "./github"
import * as Chat from "./update-chat"
import * as Github from "./update-github"
import * as CloudflareCard from "./update-cloudflare"
import { initCloudflareCard } from "./cloudflare"
import { initPrometheusCard } from "./prometheus"
import { initRailwayCard } from "./railway"
import { initPlanetscaleCard } from "./planetscale"
import { initGcpCard } from "./gcp"
import { initAwsCard } from "./aws"
import * as Aws from "./update-aws"
import { initSupabaseCard } from "./supabase"
import * as Supabase from "./update-supabase"
import * as Gcp from "./update-gcp"
import * as Configure from "./update-gcp-configure"
import * as Planetscale from "./update-planetscale"
import * as Railway from "./update-railway"
import * as Prometheus from "./update-prometheus"
import { ChartRuntime } from "../../charts/chart-runtime"
import { isMultiAccount } from "./view-cloudflare"
import * as Connect from "./update-connect"
import { isClerkAuthEnabled } from "../../lib/services/common/auth-mode"
import { CompleteOAuthReturn, LoadCustomer, LoadSession, ReadClock, StripChatParams } from "./command"
import type { OAuthReturnOutcome } from "./oauth-return"
import { chain, requestStatus, STATUS_NAMES } from "./update-status"
import { Message } from "./message"
import type { Model, Statuses } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]

const customerKey = (context: PageContext) => requestKey(context.orgId, "billing.getCustomer", {})

const requestCustomer = (model: Model, context: PageContext): Return => {
	const key = customerKey(context)
	return Option.match(Keyed.request(model.customer, key, "Load"), {
		onNone: () => ({ model }),
		onSome: (customer) => ({ model: { ...model, customer }, commands: [LoadCustomer({ key })] }),
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
 * The finished provider return: a chat flow reports through its search params, a popup whose
 * opener took the outcome waits to close, and anything else reports here.
 */
const completedOAuthReturn = (
	model: Model,
	context: PageContext,
	outcome: OAuthReturnOutcome | null,
): Return => {
	if (outcome === null) return { model }
	if (outcome.chat !== null)
		return navigateTo(model, hrefOfSearch(chatSearchOf(outcome, outcome.chat)), true)
	if (outcome.provider === null || (outcome.isHandedOff && outcome.status === "success")) return { model }
	return Connect.receivedCallback(model, context, outcome.provider, outcome.status, outcome.message)
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
			planetscale: Keyed.idle(),
			planetscaleDatabases: Keyed.idle(),
			gcp: Keyed.idle(),
			aws: Keyed.idle(),
			supabase: Keyed.idle(),
			hazel: Keyed.idle(),
			github: Keyed.idle(),
			chat: Keyed.idle(),
			scrapeTargets: Keyed.idle(),
		},
		customer: Keyed.idle(),
		isAdmin: !isClerkAuthEnabled,
		connect: initConnect(),
		disconnect: { dialog: Dialog.init("integration-disconnect", "alert-dialog"), isPending: false },
		chatCard: { busy: null, confirmId: null, identityBusy: false },
		githubCard: initGithubCard(),
		cloudflareCard: initCloudflareCard(),
		prometheusCard: initPrometheusCard(),
		planetscaleCard: initPlanetscaleCard(),
		gcpCard: initGcpCard(),
		awsCard: initAwsCard(),
		railwayCard: initRailwayCard(),
		supabaseCard: initSupabaseCard(),
	}
	const loaded = chain(model, [
		...STATUS_NAMES.map((name) => (next: Model) => requestStatus(next, context, name, "Load")),
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

/** The reads an integration's card mounts (Cloudflare's usage). */
const enterIntegration = (model: Model, context: PageContext): Return => {
	const integration = integrationOfSearch(model.search.integration)
	if (integration === "cloudflare") return CloudflareCard.enterCloudflare(model, context)
	if (integration === "aws") return Aws.enterAws(model, context)
	if (integration === "gcp")
		return chain(model, [(next) => Gcp.enterGcp(next, context), (next) => Gcp.requestBand(next, context)])
	if (integration === "supabase") return Supabase.requestMetricsRows(model, context, "Load")
	return { model }
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
			chain(
				{
					...model,
					nowMs,
					planetscaleCard: {
						...model.planetscaleCard,
						watchStartedAt: model.planetscaleCard.watchStartedAt ?? nowMs,
					},
				},
				[
					(next) => gcpBand(next, context),
					(next) => Supabase.requestMetricsRows(next, context, "Load"),
				],
			),
		CompletedLoadCloudflare: ({ key, result }) =>
			accepted(model, { ...s, cloudflare: Keyed.accept(s.cloudflare, key, result) }),
		CompletedLoadRailway: ({ key, result }) =>
			accepted(model, { ...s, railway: Keyed.accept(s.railway, key, result) }),
		CompletedLoadPlanetscale: ({ key, result }) => {
			const next = accepted(model, {
				...s,
				planetscale: Keyed.accept(s.planetscale, key, result),
			}).model
			return integrationOfSearch(next.search.integration) === "planetscale"
				? Planetscale.ensurePendingPicker(next, context)
				: { model: next }
		},
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
		CompletedLoadSupabase: ({ key, result }) => {
			const read = accepted(model, { ...s, supabase: Keyed.accept(s.supabase, key, result) }).model
			// Any answer to the current read retires saved flips; a failed one shows the last known value.
			return Supabase.requestMetricsRows(
				s.supabase.key === key ? Supabase.settledStatus(read) : read,
				context,
				"Load",
			)
		},
		CompletedLoadSupabaseMetrics: ({ key, result }) => Supabase.completedMetricsRows(model, key, result),
		CompletedLoadHazel: ({ key, result }) =>
			accepted(model, { ...s, hazel: Keyed.accept(s.hazel, key, result) }),
		CompletedLoadGithub: ({ key, result }) =>
			accepted(model, { ...s, github: Keyed.accept(s.github, key, result) }),
		CompletedLoadChat: ({ key, result }) =>
			accepted(model, { ...s, chat: Keyed.accept(s.chat, key, result) }),
		CompletedLoadScrapeTargets: ({ key, result }) =>
			accepted(model, { ...s, scrapeTargets: Keyed.accept(s.scrapeTargets, key, result) }),
		CompletedLoadCustomer: ({ key, result }) => ({
			model: { ...model, customer: Keyed.accept(model.customer, key, result) },
		}),
		CompletedLoadSession: ({ isAdmin }) => ({ model: { ...model, isAdmin } }),
		CompletedTrackConnected: () => ({ model }),
		ClickedIntegration: ({ integration }) =>
			navigateTo(model, hrefOfSearch(integration === null ? {} : { integration }), false),
		ClickedSettingsTab: ({ tab }) => navigateTo(model, `/settings?tab=${encodeURIComponent(tab)}`, false),
		CompletedChatToast: () => {
			const callback = chatCallbackOf(model.search)
			return callback === null ? { model } : navigateTo(model, hrefOfSearch(callback.next), true)
		},
		ClickedConnect: () => Connect.clickedConnect(model),
		ClickedChatInstall: () => Chat.clickedInstall(model),
		CompletedLoadCloudflareUsage: ({ key, result }) => ({
			model: {
				...model,
				cloudflareCard: {
					...model.cloudflareCard,
					usage: Keyed.accept(model.cloudflareCard.usage, key, result),
				},
			},
		}),
		CompletedCloudflarePrime: ({ isOk, isConnected }) =>
			CloudflareCard.completedPrime(model, context, isOk, isConnected),
		TickedCloudflareIngest: () => {
			// The ingest phase (stalled, backfill) follows the clock, so each tick rereads it.
			const refreshed = CloudflareCard.refreshCloudflare(model, context)
			return { ...refreshed, commands: [...(refreshed.commands ?? []), ReadClock()] }
		},
		GotZoneFilterMessage: ({ message: child }) => CloudflareCard.gotZoneFilter(model, child),
		ChangedZoneSearch: ({ value }) => CloudflareCard.updateBoard(model, { zoneSearch: value }),
		ClickedZoneSort: ({ key }) => CloudflareCard.clickedZoneSort(model, key),
		ClickedWorkersExpand: () =>
			CloudflareCard.updateBoard(model, { workersExpanded: !model.cloudflareCard.workersExpanded }),
		CompletedLoadChartRuntime: () =>
			CloudflareCard.updateBoard(model, { chartRuntime: ChartRuntime.Ready() }),
		FailedLoadChartRuntime: ({ reason }) =>
			CloudflareCard.updateBoard(model, { chartRuntime: ChartRuntime.Failed({ reason }) }),
		GotSparklineMessage: () => ({ model }),
		ClickedTarget: ({ id }) => Prometheus.clickedTarget(model, context, id),
		ClickedTargetControls: () => ({ model }),
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
		ClickedAddTarget: () => Prometheus.clickedAdd(model),
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
		GotRailwayTokenMessage: ({ message: child }) => Railway.gotToken(model, child),
		SubmittedRailwayToken: () => Railway.submittedToken(model),
		SucceededRailwayConnect: ({ title, description }) =>
			Railway.succeededConnect(model, context, title, description),
		FailedRailwayConnect: ({ error }) => Railway.failedConnect(model, error),
		ClickedRailwaySync: () => Railway.clickedSync(model),
		CompletedRailwaySync: ({ failure }) => Railway.completedSync(model, context, failure),
		ClickedRailwayRotate: () => Railway.setRotating(model, true),
		ClickedRailwayRotateCancel: () => Railway.setRotating(model, false),
		TickedRailwaySettle: () => requestStatus(model, context, "railway", "Refresh"),
		GotAwsAccountIdMessage: ({ message: child }) => Aws.gotAccountId(model, child),
		GotAwsRegionsMessage: ({ message: child }) => Aws.gotRegions(model, child),
		SubmittedAwsAccount: () => Aws.submittedAccount(model),
		SucceededAwsCreate: ({ connection }) => Aws.succeededCreate(model, context, connection),
		FailedAwsCreate: ({ error }) => Aws.failedCreate(model, error),
		ClickedAwsAdd: () => Aws.setAdding(model, true),
		ClickedAwsAddCancel: () => Aws.setAdding(model, false),
		ClickedAwsSetup: ({ id }) => Aws.openSetup(model, context, id),
		ClickedAwsSetupClose: () => Aws.closeSetup(model),
		CompletedLoadAwsSetup: ({ key, result }) => Aws.completedLoadSetup(model, key, result),
		CompletedLoadAwsIngest: ({ id, key, result }) => Aws.completedIngest(model, id, key, result),
		ClickedAwsSetupMethod: ({ method }) => Aws.setMethod(model, method),
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
		GotAwsMetricsRegionsMessage: ({ message: child }) => Aws.gotMetricsRegions(model, child),
		SubmittedAwsMetrics: () => Aws.submittedMetrics(model),
		CompletedAwsMetricStream: ({ connection, error }) =>
			Aws.completedMetricStream(model, context, connection, error),
		// Advances the card's window and "Last data" ages; the fresh clock re-reads rows on a new key.
		TickedSupabaseClock: () => ({ model, commands: [ReadClock()] }),
		CompletedReadSupabaseClock: ({ nowMs }) => Supabase.completedReadClock(model, context, nowMs),
		ClickedSupabaseSync: () => Supabase.clickedSync(model),
		CompletedSupabaseSync: ({ failure }) => Supabase.completedSync(model, context, failure),
		ToggledSupabaseMetrics: ({ ref, enabled }) => Supabase.toggledMetrics(model, ref, enabled),
		CompletedSupabaseMetrics: ({ ref, enabled, failure }) =>
			Supabase.completedMetrics(model, context, ref, enabled, failure),
		ToggledSupabaseLogs: ({ ref, enabled }) => Supabase.toggledLogs(model, ref, enabled),
		CompletedSupabaseLogs: ({ ref, enabled, failure }) =>
			Supabase.completedLogs(model, context, ref, enabled, failure),
		ToggledSupabaseLogDrain: ({ ref, enabled }) => Supabase.toggledLogDrain(model, ref, enabled),
		CompletedSupabaseLogDrain: ({ ref, enabled, failure }) =>
			Supabase.completedLogDrain(model, context, ref, enabled, failure),
		CompletedFetchOrganizations: ({ key, result }) =>
			Planetscale.updateCard(model, {
				organizations: Keyed.accept(model.planetscaleCard.organizations, key, result),
			}),
		ClickedChangeOrganization: () => Planetscale.clickedChange(model, context),
		GotPickerDialogMessage: ({ message: child }) => Planetscale.gotPickerDialog(model, child),
		SelectedOrganization: ({ name }) => Planetscale.updateCard(model, { selectedOrg: name }),
		GotBranchFieldMessage: ({ field, message: child }) => Planetscale.gotBranchField(model, field, child),
		ClickedPickerCancel: () =>
			model.planetscaleCard.pickerDialog.isOpen
				? Planetscale.clickedPickerCancel(model)
				: withDisconnectDialog(model, Dialog.open(model.disconnect.dialog)),
		SubmittedOrganization: () => Planetscale.submittedOrganization(model),
		CompletedSelectOrganization: ({ organization, failure }) =>
			Planetscale.completedSelect(model, context, organization, failure),
		ClickedRotateToken: () => Planetscale.updateCard(model, { isRotating: true }),
		ClickedRotateCancel: () => Planetscale.updateCard(model, { isRotating: false }),
		GotMetricsTokenMessage: ({ field, message: child }) => Planetscale.gotTokenField(model, field, child),
		PastedMetricsToken: ({ field, text }) => Planetscale.pastedToken(model, field, text),
		SubmittedMetricsToken: () => Planetscale.submittedToken(model),
		CompletedSetMetricsToken: ({ error }) => Planetscale.completedToken(model, context, error),
		ClickedMetricsDetails: () =>
			Planetscale.updateCard(model, { isDetailsOpen: !model.planetscaleCard.isDetailsOpen }),
		TickedPlanetscaleWatch: () => {
			const refreshed = requestStatus(model, context, "planetscale", "Refresh")
			return { ...refreshed, commands: [...(refreshed.commands ?? []), ReadClock()] }
		},
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
		SubmittedGcpScope: () => Configure.submittedScope(model),
		SubmittedGcpCreate: () => Configure.submittedCreate(model),
		ClickedGcpConfigureBack: () => Configure.clickedBack(model),
		ToggledGcpCollect: ({ capability }) => Configure.toggledCollect(model, capability),
		ClickedGcpLogFilter: () => Configure.clickedLogFilter(model),
		GotGcpFilterModeMessage: ({ message: child }) => Configure.gotFilterMode(model, child),
		ClickedGcpForwardOutput: () => Configure.clickedForwardOutput(model),
		ClickedGcpUseOpenTelemetry: () => Configure.clickedUseOpenTelemetry(model),
		ToggledGcpRuntime: ({ runtime }) => Configure.toggledRuntime(model, runtime),
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
		CompletedChatInstall: ({ failure }) => Chat.completedInstall(model, context, failure),
		ClickedChatIdentity: () => Chat.clickedIdentity(model),
		CompletedChatIdentity: ({ kind, failure }) => Chat.completedIdentity(model, context, kind, failure),
		ClickedChatDisconnect: ({ workspaceId }) => Chat.clickedDisconnect(model, workspaceId),
		CompletedChatDisconnect: ({ failure }) => Chat.completedDisconnect(model, context, failure),
		SucceededStartConnect: ({ attempt }) => Connect.succeededStart(model, context, attempt),
		FailedStartConnect: ({ attempt, title, description }) =>
			Connect.failedStart(model, attempt, title, description),
		BlockedConnectPopup: ({ attempt }) => Connect.blockedPopup(model, context, attempt),
		PolledConnect: ({ attempt }) => Connect.polled(model, context, attempt),
		ClosedConnectPopup: ({ attempt }) => Connect.closedPopup(model, context, attempt),
		EndedConnectGrace: ({ attempt }) => Connect.endedGrace(model, attempt),
		ReceivedConnectMessage: ({ provider, status, message: text }) =>
			Connect.receivedCallback(model, context, provider, status, text),
		CompletedOAuthReturn: ({ outcome }) => completedOAuthReturn(model, context, outcome),
		ClickedRetryStatus: ({ name }) => requestStatus(model, context, name, "Supersede"),
		ClickedDisconnect: () => withDisconnectDialog(model, Dialog.open(model.disconnect.dialog)),
		GotDisconnectDialogMessage: ({ message: child }) =>
			model.disconnect.isPending ||
			(model.chatCard.busy !== null && model.chatCard.busy === model.chatCard.confirmId)
				? { model }
				: withDisconnectDialog(model, Dialog.update(model.disconnect.dialog, child)),
		ConfirmedDisconnect: () => {
			const integration = integrationOfSearch(model.search.integration)
			if (integration !== null && chatConnectorOf(integration) !== null)
				return Chat.confirmedDisconnect(model)
			if (integration === null || model.disconnect.isPending) return { model }
			const closed = withDisconnectDialog(model, Dialog.close(model.disconnect.dialog))
			return {
				...closed,
				model: { ...closed.model, disconnect: { ...closed.model.disconnect, isPending: true } },
				commands: [
					...(closed.commands ?? []),
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
			const settled = { ...model, disconnect: { ...model.disconnect, isPending: false } }
			if (spec === undefined) return { model: settled }
			const toast = PageOutMessage.RequestedToast(
				failure === null
					? { type: "success", title: spec.success, description: "" }
					: { type: "error", title: spec.error, description: failure.message },
			)
			return chain(settled, [
				(next) => ({ model: next, outMessage: toast }),
				...(failure === null ? spec.refresh : []).map(
					(name) => (next: Model) => requestStatus(next, context, name, "Supersede"),
				),
				(next) =>
					failure === null && integration.startsWith("cloudflare")
						? CloudflareCard.requestUsage(next, context, "Refresh")
						: { model: next },
			])
		},
	})
}

const withDisconnectDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, disconnect: { ...model.disconnect, dialog: step.model } },
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotDisconnectDialogMessage({ message }),
	),
})
