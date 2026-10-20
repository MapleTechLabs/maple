import { Command } from "foldkit"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import * as Frame from "../../kit/frame"
import { routeFrame } from "../../kit/frame-step"
import * as InstallModal from "../../kit/install-modal"
import { applySteps, keyed } from "../../kit/requests"
import { nextSort } from "../../../kit/table-sort"
import { FetchHosts, HOST_LIST_LIMIT } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]

export const DEFAULT_PRESET = "12h"

const scopeOf = (model: Model, context: PageContext): Frame.Scope => ({
	search: model.search,
	defaultPreset: DEFAULT_PRESET,
	timeZone: context.timeZone,
})

const requestAll = (model: Model, context: PageContext, mode: Frame.RequestMode): Return => {
	const window = model.frame.window
	if (window === null) return { model }
	const input = { startTime: window.startTime, endTime: window.endTime, limit: HOST_LIST_LIMIT }
	return applySteps<Model, Message>(model, [
		keyed(
			model.hosts,
			requestKey(context.orgId, "listHosts", { data: input }),
			mode,
			(hosts) => ({ hosts }),
			(key) => FetchHosts({ key, window }),
		),
	])
}

/** `navigate({ search: (prev) => ({ ...prev, ...patch }) })`. */
const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.InfraHosts({ search })),
		isReplace: false,
	}),
})

const liftInstall = (model: Model, result: InstallModal.Return): Return => ({
	model: { ...model, install: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotInstallMessage({ message })),
})

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	// The page-level modal mounts with the page, so the key is fetched on entry.
	const install = liftInstall(
		{
			search: route.search,
			frame: Frame.init("infra-hosts-time-range"),
			hosts: Keyed.idle(),
			sort: { key: "cpuPct", dir: "desc" },
			install: InstallModal.init("infra-hosts-install", "hosts"),
		},
		InstallModal.load(InstallModal.init("infra-hosts-install", "hosts")),
	)
	return {
		model: install.model,
		commands: [
			Command.mapMessage(Frame.resolve(install.model.frame, scopeOf(install.model, context), "Load"), (message) =>
				Message.GotFrameMessage({ message }),
			),
			...(install.commands ?? []),
		],
	}
}

const searchHref = (search: Search) => hrefOf(AppRoute.InfraHosts({ search }))

/** Only a window change re-requests; `q` and `scope` filter the loaded list. */
export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (searchHref(model.search) === searchHref(route.search)) return { model }
	const next = { ...model, search: route.search }
	const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })
	return routeFrame(model.search, next, scopeOf(next, context), toFrame, (moved, mode) => requestAll(moved, context, mode))
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	requestAll(model, context, "Load")

const updateFrame = (model: Model, message: Frame.Message, context: PageContext): Return => {
	const next = Frame.update(model.frame, message, scopeOf(model, context))
	const lifted: Return = {
		model: { ...model, frame: next.model },
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotFrameMessage({ message: inner }),
		),
	}
	const out = next.outMessage
	if (out === undefined) return lifted
	if (out._tag === "ChangedTimeSearch")
		return { ...navigate(lifted.model, { ...model.search, ...out.search }), commands: lifted.commands }
	const requested = requestAll(lifted.model, context, out.mode)
	return { ...requested, commands: [...(lifted.commands ?? []), ...(requested.commands ?? [])] }
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchHosts: ({ key, result }) => ({
			model: { ...model, hosts: Keyed.accept(model.hosts, key, result) },
		}),
		ChangedQuery: ({ value }) =>
			navigate(model, { ...model.search, q: value === "" ? undefined : value }),
		ChangedScope: ({ scope }) => navigate(model, { ...model.search, scope }),
		ClickedClearSearch: () => navigate(model, { ...model.search, q: undefined, scope: undefined }),
		ClickedSort: ({ key }) => ({ model: { ...model, sort: nextSort(model.sort, key, { stringKeys: ["hostName"] }) } }),
		GotFrameMessage: ({ message: inner }) => updateFrame(model, inner, context),
		GotInstallMessage: ({ message: inner }) =>
			liftInstall(model, InstallModal.update(model.install, inner)),
	})
