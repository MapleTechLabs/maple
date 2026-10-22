import { Option } from "effect"
import { Command } from "foldkit"
import { presenceKey } from "../../../data/infra-surfaces"
import * as Keyed from "../../../data/keyed"
import type { LoadFailure } from "../../../data/load-failure"
import { requestKey } from "../../../data/request-key"
import { AppRoute, hrefOf } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import * as Frame from "../kit/frame"
import { liftFrame, resolveFrame, routeFrame } from "../kit/frame-step"
import * as InstallModal from "../kit/install-modal"
import { seriesSteps } from "../kit/requests"
import { FetchPresence, FetchSource } from "./command"
import { Message } from "./message"
import type { Model, SourceReading } from "./model"
import { presentSources, surfacesOf } from "./state"

type Return = PageReturn<Model, Message>
type Search = Model["search"]

export const DEFAULT_PRESET = "1h"

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })
const scopeOf = (model: Model, context: PageContext): Frame.Scope => ({
	search: model.search,
	defaultPreset: DEFAULT_PRESET,
	timeZone: context.timeZone,
})

/** The sources presence shows (every one until it is known, `presentSources(null)`); each mounts its read. */
const requestSources = (model: Model, context: PageContext, mode: Frame.RequestMode): Return => {
	const window = model.frame.window
	if (window === null) return { model }
	const input = { startTime: window.startTime, endTime: window.endTime }
	const requested = seriesSteps<SourceReading, LoadFailure, Message>(
		model.sources,
		presentSources(surfacesOf(model, context)).map((source) => ({
			id: source,
			key: requestKey(context.orgId, `infraOverview.${source}`, { data: input }),
			fetch: (key: string) => FetchSource({ source, key, window }),
		})),
		mode,
	)
	return {
		model: { ...model, sources: { ...model.sources, ...requested.slots } },
		commands: requested.commands,
	}
}

/** The window's presence probe (a new window keeps the last answer meanwhile), then its sources. */
const requestAll = (model: Model, context: PageContext, mode: Frame.RequestMode): Return => {
	const window = model.frame.window
	if (window === null) return { model }
	const key = presenceKey(context.orgId, window)
	const probed = Option.match(Keyed.request(model.presence, key, "Load"), {
		onNone: () => ({ model, commands: [] }),
		onSome: (presence) => ({
			model: { ...model, presence },
			commands: [FetchPresence({ orgId: context.orgId, key, window })],
		}),
	})
	const sources = requestSources(probed.model, context, mode)
	return { model: sources.model, commands: [...probed.commands, ...(sources.commands ?? [])] }
}

const liftInstall = (model: Model, result: InstallModal.Return): Return => ({
	model: { ...model, install: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotInstallMessage({ message })),
})

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const install = InstallModal.init("infra-overview-install", "hosts")
	const model: Model = {
		search: route.search,
		frame: Frame.init("infra-overview-time-range"),
		presence: Keyed.idle(),
		sources: {
			hosts: Keyed.idle(),
			containers: Keyed.idle(),
			kubernetes: Keyed.idle(),
			cloudflare: Keyed.idle(),
			railway: Keyed.idle(),
			supabase: Keyed.idle(),
			planetscale: Keyed.idle(),
			gcp: Keyed.idle(),
		},
		install,
	}
	// The page-level modal mounts with the page, so the key is fetched on entry.
	const loaded = liftInstall(model, InstallModal.load(install))
	return {
		model: loaded.model,
		commands: [
			resolveFrame(model.frame, scopeOf(model, context), toFrame, "Load"),
			...(loaded.commands ?? []),
		],
		// The sidebar's statuses (and its last-hour probe, below `md` too); the page probes its own window.
		outMessage: PageOutMessage.RequestedInfraSurfaces(),
	}
}

const searchHref = (search: Search) => hrefOf(AppRoute.Infra({ search }))

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return => {
	if (searchHref(model.search) === searchHref(route.search)) return { model }
	const next = { ...model, search: route.search }
	return routeFrame(model.search, next, scopeOf(next, context), toFrame, (moved, mode) =>
		requestAll(moved, context, mode),
	)
}

export const contextChanged = (model: Model, context: PageContext): Return =>
	requestAll(model, context, "Load")

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: searchHref(search), isReplace: false }),
})

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchPresence: ({ key, result }) =>
			requestSources(
				{ ...model, presence: Keyed.accept(model.presence, key, result) },
				context,
				"Load",
			),
		CompletedFetchSource: ({ source, key, result }) => ({
			model: {
				...model,
				sources: { ...model.sources, [source]: Keyed.accept(model.sources[source], key, result) },
			},
		}),
		GotFrameMessage: ({ message: inner }) =>
			liftFrame(model, inner, scopeOf(model, context), toFrame, {
				onResolved: (next, mode) => requestAll(next, context, mode),
				onTimeSearch: (next, search) => navigate(next, { ...next.search, ...search }),
			}),
		GotInstallMessage: ({ message: inner }) =>
			liftInstall(model, InstallModal.update(model.install, inner)),
	})
