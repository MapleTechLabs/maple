import type { Resources } from "./platform/resources"
import * as Dialog from "@maple/web/ui/dialog"
import { AsyncData, Command } from "foldkit"
import { Option } from "effect"
import { FetchSignalPresence, GoBack, Navigate, ProbeServer, RememberRange } from "./command"
import { Message } from "./message"
import { initFilterDrawer, type Model } from "./model"
import { canGoBack } from "./navigation"
import { shownDataOf } from "./data/shown"
import { type PageContext, PageOutMessage } from "./page/contract"
import { stopSuperseded } from "./data/lanes"
import {
	initPage,
	lanesOf,
	locationChanged,
	pageKeyOf,
	type PageMessage,
	refreshPage,
	updatePage,
} from "./page/registry"

export type RootReturn = Readonly<{
	model: Model
	commands?: ReadonlyArray<Command.Command<Message, never, Resources>>
}>

export const pageContextOf = (model: Model): PageContext => ({
	env: model.env,
	location: model.location,
	rememberedRange: model.rememberedRange,
	timeFormat: model.timeFormat,
	canGoBack: canGoBack(model.visited),
})

const toPageMessage = (message: PageMessage) => Message.GotPageMessage({ message })

/** `useSignalPresence` mounting: reuse the shared read unless it is loading or stale. */
const requestPresence = (model: Model): RootReturn => {
	if (AsyncData.isLoading(model.presence) || AsyncData.isRefreshing(model.presence)) return { model }
	const lastReadAtMs = model.isPresenceStale
		? null
		: Option.match(AsyncData.getData(model.presence), {
				onNone: () => null,
				onSome: (result) => result.nowMs,
			})
	const presence = Option.getOrElse(AsyncData.revalidateOrLoad(model.presence), () => model.presence)
	return {
		model: { ...model, presence, isPresenceStale: false },
		commands: [FetchSignalPresence({ apiBase: model.env.apiBase, lastReadAtMs })],
	}
}

/** One step of the Filters drawer's Dialog, its Commands lifted. */
export const filterDrawerStep = (model: Model, step: ReturnType<typeof Dialog.update>): RootReturn => ({
	model: { ...model, filterDrawer: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotFilterDrawerMessage({ message }),
	),
})

/** Start a probe now, retiring any pending timer. */
export const probe = (model: Model): RootReturn =>
	model.probe.isInFlight
		? { model }
		: {
				model: { ...model, probe: { isInFlight: true, version: model.probe.version + 1 } },
				commands: [ProbeServer({ apiBase: model.env.apiBase })],
			}

/** A page asked the root for something only the root may do. */
export const foldPageOut = (model: Model, outMessage: PageOutMessage): RootReturn =>
	PageOutMessage.match<RootReturn>(outMessage, {
		RequestedNavigation: ({ hash, isReplace }) => ({
			model: { ...model, isReplacing: isReplace },
			commands: [Navigate({ hash, isReplace })],
		}),
		RequestedBack: ({ fallbackHash }) =>
			canGoBack(model.visited)
				? { model, commands: [GoBack()] }
				: { model, commands: [Navigate({ hash: fallbackHash, isReplace: false })] },
		RememberedRange: ({ range, hash }) => ({
			model: { ...model, rememberedRange: range, isReplacing: true },
			commands: [RememberRange({ range }), Navigate({ hash, isReplace: true })],
		}),
		RequestedSignalPresence: () => requestPresence(model),
		RefetchedInPlace: () => probe({ ...model, isPresenceStale: true }),
		RequestedFilterDrawer: () => filterDrawerStep(model, Dialog.open(model.filterDrawer)),
	})

/** Folds one page step's Model, Commands and OutMessage into the root. */
const applyPage = (
	model: Model,
	step: Readonly<{
		model: Model["page"]
		commands?: ReadonlyArray<Command.Command<PageMessage, never, Resources>>
		outMessage?: PageOutMessage
	}>,
): RootReturn => {
	const withPage = {
		...model,
		page: step.model,
		hasCache: model.hasCache || shownDataOf(step.model, 0).hasData,
	}
	const stops = stopSuperseded(lanesOf(model.page), lanesOf(step.model), (outcome) =>
		Message.CompletedCancelPageFetch({ outcome }),
	)
	const pageCommands = [...stops, ...Command.mapMessages(step.commands ?? [], toPageMessage)]
	if (step.outMessage === undefined) return { model: withPage, commands: pageCommands }
	const folded = foldPageOut(withPage, step.outMessage)
	return { model: folded.model, commands: [...pageCommands, ...(folded.commands ?? [])] }
}

/** A new route builds a new page; the same page sees the new fragment as `locationChanged`. */
export const enterLocation = (model: Model, previousKey: string | null): RootReturn => {
	const context = pageContextOf(model)
	return previousKey === pageKeyOf(model.route)
		? applyPage(model, locationChanged(model.page, context))
		: applyPage({ ...model, filterDrawer: initFilterDrawer() }, initPage(model.route, context))
}

export const updatePageMessage = (model: Model, message: PageMessage): RootReturn =>
	applyPage(model, updatePage(model.page, message, pageContextOf(model)))

/** The notice's Try again: probe now and refetch the open page (`refetchQueries(["local"])`). */
export const retryStaleData = (model: Model): RootReturn => {
	const probed = probe(model)
	const refreshed = applyPage(probed.model, refreshPage(probed.model.page, pageContextOf(probed.model)))
	return { model: refreshed.model, commands: [...(probed.commands ?? []), ...(refreshed.commands ?? [])] }
}
