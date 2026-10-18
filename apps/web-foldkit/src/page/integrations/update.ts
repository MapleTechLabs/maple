import { Option } from "effect"
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
import * as Prometheus from "./update-prometheus"
import { ChartRuntime } from "../../charts/chart-runtime"
import { isMultiAccount } from "./view-cloudflare"
import * as Connect from "./update-connect"
import { LoadCustomer, ReadClock, StripChatParams } from "./command"
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
 * callback's full-page load) legacy's toast is added before its toast region subscribes and is
 * lost; `withToast: false` keeps that (only the strip runs).
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
			hazel: Keyed.idle(),
			github: Keyed.idle(),
			chat: Keyed.idle(),
			scrapeTargets: Keyed.idle(),
		},
		customer: Keyed.idle(),
		connect: initConnect(),
		disconnect: { dialog: Dialog.init("integration-disconnect", "alert-dialog"), isPending: false },
		chatCard: { busy: null, confirmId: null, identityBusy: false },
		githubCard: initGithubCard(),
		cloudflareCard: initCloudflareCard(),
		prometheusCard: initPrometheusCard(),
	}
	const loaded = chain(model, [
		...STATUS_NAMES.map((name) => (next: Model) => requestStatus(next, context, name, "Load")),
		(next: Model) => requestCustomer(next, context),
		(next: Model) => enterIntegration(next, context),
		(next: Model) => handleChatCallback(next, false),
	])
	return { ...loaded, commands: [ReadClock(), ...(loaded.commands ?? [])] }
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
const enterIntegration = (model: Model, context: PageContext): Return =>
	integrationOfSearch(model.search.integration) === "cloudflare"
		? CloudflareCard.enterCloudflare(model, context)
		: { model }

export const contextChanged = (model: Model): Return => ({ model })

const accepted = (model: Model, statuses: Statuses): Return => ({ model: { ...model, statuses } })

export const update = (model: Model, message: Message, context: PageContext): Return => {
	const s = model.statuses
	return Message.match<Return>(message, {
		CompletedReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedLoadCloudflare: ({ key, result }) =>
			accepted(model, { ...s, cloudflare: Keyed.accept(s.cloudflare, key, result) }),
		CompletedLoadRailway: ({ key, result }) =>
			accepted(model, { ...s, railway: Keyed.accept(s.railway, key, result) }),
		CompletedLoadPlanetscale: ({ key, result }) =>
			accepted(model, { ...s, planetscale: Keyed.accept(s.planetscale, key, result) }),
		CompletedLoadPlanetscaleDatabases: ({ key, result }) =>
			accepted(model, {
				...s,
				planetscaleDatabases: Keyed.accept(s.planetscaleDatabases, key, result),
			}),
		CompletedLoadGcp: ({ key, result }) =>
			accepted(model, { ...s, gcp: Keyed.accept(s.gcp, key, result) }),
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
		TickedCloudflareIngest: () => CloudflareCard.refreshCloudflare(model, context),
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
		CompletedTrackedBranch: ({ branch, backfillQueued, failure }) =>
			Github.completedTrackedBranch(model, context, branch, backfillQueued, failure),
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
		ClickedRetryStatus: ({ name }) => requestStatus(model, context, name, "Refresh"),
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
					(name) => (next: Model) => requestStatus(next, context, name, "Refresh"),
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
