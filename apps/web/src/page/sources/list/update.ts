import { Option } from "effect"
import { Command } from "foldkit"
import * as ToggleGroup from "../../../ui/toggle-group"
import * as Keyed from "../../../data/keyed"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { sourcesListKey, sourcesUsageKey } from "../kit/data"
import { FetchSourcesList, FetchSourcesUsage, ReadSourcesClock } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>

const loadList = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const key = sourcesListKey(context.orgId)
	return Option.match(Keyed.request(model.list, key, mode), {
		onNone: () => ({ model }),
		onSome: (list) => ({
			model: { ...model, list },
			commands: [FetchSourcesList({ key, refresh: mode === "Refresh" })],
		}),
	})
}

const loadUsage = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const key = sourcesUsageKey(context.orgId)
	return Option.match(Keyed.request(model.usage, key, mode), {
		onNone: () => ({ model }),
		onSome: (usage) => ({
			model: { ...model, usage },
			commands: [FetchSourcesUsage({ key, refresh: mode === "Refresh" })],
		}),
	})
}

/** The list and its volumes, read side by side; a retry re-reads the volumes only if they are missing. */
const load = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const list = loadList(model, context, mode)
	const usage = loadUsage(list.model, context, "Load")
	return { model: usage.model, commands: [...(list.commands ?? []), ...(usage.commands ?? [])] }
}

export const init = (_route: unknown, context: PageContext): Return => {
	const kindFilter = ToggleGroup.init({ label: "Filter sources by kind", values: ["all"] })
	const attentionFilter = ToggleGroup.init({
		label: "Filter sources by health",
		isMultiple: true,
		values: [],
	})
	const loaded = load(
		{ nowMs: null, list: Keyed.idle(), usage: Keyed.idle(), kindFilter, attentionFilter },
		context,
		"Load",
	)
	return { model: loaded.model, commands: [ReadSourcesClock(), ...(loaded.commands ?? [])] }
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchList: ({ key, result }) => ({
			model: { ...model, list: Keyed.accept(model.list, key, result) },
		}),
		CompletedFetchUsage: ({ key, result }) => ({
			model: { ...model, usage: Keyed.accept(model.usage, key, result) },
		}),
		ClickedRetry: () => load(model, context, "Refresh"),
		GotKindFilterMessage: ({ message: child }) => {
			const next = ToggleGroup.update(model.kindFilter, child)
			return {
				// Unpressing the active chip falls back to All, like the zone filter.
				model: {
					...model,
					kindFilter:
						next.model.values.length === 0 ? { ...next.model, values: ["all"] } : next.model,
				},
				commands: Command.mapMessages(next.commands ?? [], (inner) =>
					Message.GotKindFilterMessage({ message: inner }),
				),
			}
		},
		GotAttentionFilterMessage: ({ message: child }) => {
			const next = ToggleGroup.update(model.attentionFilter, child)
			return {
				model: { ...model, attentionFilter: next.model },
				commands: Command.mapMessages(next.commands ?? [], (inner) =>
					Message.GotAttentionFilterMessage({ message: inner }),
				),
			}
		},
		ClickedSource: ({ url }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }),
		}),
	})
