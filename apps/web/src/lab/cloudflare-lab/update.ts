import { Effect, Option } from "effect"
import { Command, type Update } from "foldkit"
import { fromString as urlFromString } from "foldkit/url"
import type * as List from "../../page/infra-integrations/cloudflare/list/model"
import * as ListUpdate from "../../page/infra-integrations/cloudflare/list/update"
import * as WorkerUpdate from "../../page/infra-integrations/cloudflare/worker/update"
import * as ZoneUpdate from "../../page/infra-integrations/cloudflare/zone/update"
import type { Resources } from "../../platform/resources"
import { urlToAppRoute } from "../../route"
import { LAB_CONTEXT, pinWorker, pinZone, withoutReads } from "./fixture"
import { type Flags, type LabPage, Message, type Model } from "./model"

export type Return = Update.Return<Model, Message, Resources>

const toList = (message: List.Message): Message => Message.GotListMessage({ message })

const isListPage = (page: LabPage): boolean => page !== "zone" && page !== "worker"

const initList = (view: List.View) => ListUpdate.init({ search: { view } }, LAB_CONTEXT)
const initZone = () => ZoneUpdate.init({ zoneName: "maple.dev", search: {} }, LAB_CONTEXT)
const initWorker = () => WorkerUpdate.init({ scriptName: "maple-api", search: {} }, LAB_CONTEXT)

/** A remounted page keeps the chart runtime and the resolved theme; its own state starts over. */
const remount = <A extends { chartRuntime: unknown; themeColors: unknown }>(fresh: A, previous: A): A => ({
	...fresh,
	chartRuntime: previous.chartRuntime,
	themeColors: previous.themeColors,
})

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
}))

export const init = (flags: Flags): Return => {
	const list = initList("zones")
	const zone = initZone()
	const worker = initWorker()
	return {
		model: {
			timeZone: flags.timeZone,
			page: "zones",
			multiView: "zones",
			list: list.model,
			zone: pinZone(zone.model),
			worker: pinWorker(worker.model),
		},
		commands: [
			...Command.mapMessages(withoutReads(list.commands), toList),
			...Command.mapMessages(withoutReads(zone.commands), (message) =>
				Message.GotZoneMessage({ message }),
			),
			...Command.mapMessages(withoutReads(worker.commands), (message) =>
				Message.GotWorkerMessage({ message }),
			),
		],
	}
}

/** One `ListPage` is kept across the list pages; the zone and Worker pages start fresh. */
const showPage = (model: Model, page: LabPage): Model => {
	if (page === model.page) return model
	if (page === "zone") return { ...model, page, zone: pinZone(remount(initZone().model, model.zone)) }
	if (page === "worker")
		return { ...model, page, worker: pinWorker(remount(initWorker().model, model.worker)) }
	const view = page === "accounts" ? model.multiView : page
	const list = isListPage(model.page)
		? { ...model.list, search: { ...model.list.search, view } }
		: remount(initList(view).model, model.list)
	return { ...model, page, list }
}

/** A list URL write, applied to the list's own `search` the way a route change would. */
const followNavigation = (list: List.Model, url: string): List.Model =>
	Option.match(urlFromString(new URL(url, "http://localhost").href), {
		onNone: () => list,
		onSome: (parsed) => {
			const route = urlToAppRoute(parsed)
			return route._tag === "InfraCloudflare" ? { ...list, search: route.search } : list
		},
	})

/** The list's view tabs drive the lab pivot (`onViewChange`), or the demo page's own view. */
const listStep = (model: Model, message: List.Message): Return => {
	const next = ListUpdate.update(model.list, message, LAB_CONTEXT)
	const out = next.outMessage
	const list =
		out !== undefined && out._tag === "RequestedNavigation"
			? followNavigation(next.model, out.url)
			: next.model
	const view = list.search.view
	const synced: Model =
		model.page === "accounts"
			? { ...model, list, multiView: view ?? model.multiView }
			: { ...model, list, page: view ?? model.page }
	return { model: synced, commands: Command.mapMessages(withoutReads(next.commands), toList) }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ClickedLabPage: ({ page }) => ({ model: showPage(model, page) }),
		GotListMessage: ({ message: inner }) => listStep(model, inner),
		// The "Zone view" pivot is fixed on Traffic.
		GotZoneMessage: ({ message: inner }) => {
			if (inner._tag === "ClickedTab") return { model }
			const next = ZoneUpdate.update(model.zone, inner, LAB_CONTEXT)
			return {
				model: { ...model, zone: pinZone(next.model) },
				commands: Command.mapMessages(withoutReads(next.commands), (child) =>
					Message.GotZoneMessage({ message: child }),
				),
			}
		},
		GotWorkerMessage: ({ message: inner }) => {
			const next = WorkerUpdate.update(model.worker, inner, LAB_CONTEXT)
			return {
				model: { ...model, worker: pinWorker(next.model) },
				commands: Command.mapMessages(withoutReads(next.commands), (child) =>
					Message.GotWorkerMessage({ message: child }),
				),
			}
		},
	})
