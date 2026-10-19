import { Option } from "effect"
import * as Keyed from "../../../data/keyed"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { sourcesListKey } from "../kit/data"
import { FetchSourcesList, ReadSourcesClock } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>

const load = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const key = sourcesListKey(context.orgId)
	return Option.match(Keyed.request(model.list, key, mode), {
		onNone: () => ({ model }),
		onSome: (list) => ({
			model: { ...model, list },
			commands: [FetchSourcesList({ key, refresh: mode === "Refresh" })],
		}),
	})
}

export const init = (_route: unknown, context: PageContext): Return => {
	const loaded = load({ nowMs: null, list: Keyed.idle() }, context, "Load")
	return { model: loaded.model, commands: [ReadSourcesClock(), ...(loaded.commands ?? [])] }
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchList: ({ key, result }) => ({ model: { ...model, list: Keyed.accept(model.list, key, result) } }),
		ClickedRetry: () => load(model, context, "Refresh"),
		ClickedSource: ({ url }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }),
		}),
	})
