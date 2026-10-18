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
import * as Chat from "./update-chat"
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
	}
	const loaded = chain(model, [
		...STATUS_NAMES.map((name) => (next: Model) => requestStatus(next, context, name, "Load")),
		(next: Model) => requestCustomer(next, context),
		(next: Model) => handleChatCallback(next, false),
	])
	return { ...loaded, commands: [ReadClock(), ...(loaded.commands ?? [])] }
}

export const routeChanged = (model: Model, route: { readonly search: Search }): Return =>
	hrefOfSearch(model.search) === hrefOfSearch(route.search)
		? { model }
		: handleChatCallback({ ...model, search: route.search }, true)

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
				commands: [...(closed.commands ?? []), Disconnect({ integration })],
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
