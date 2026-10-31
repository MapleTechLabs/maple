import { Option } from "effect"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { AppRoute } from "../../../route"
import type { PageContext, PageReturn } from "../../contract"
import { FetchListSession, FetchStatusPages, ReadListClock } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

export type Return = PageReturn<Model, Message>

type ListRoute = Extract<AppRoute, { readonly _tag: "StatusPages" }>

const pagesKey = (context: PageContext) => requestKey(context.orgId, "statusPages.summaries", {})

const request = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return =>
	Option.match(Keyed.requestFor(model.pages, pagesKey(context), mode), {
		onNone: () => ({ model }),
		onSome: (pages) => ({ model: { ...model, pages }, commands: [FetchStatusPages({ key: pages.key })] }),
	})

export const init = (_route: ListRoute, context: PageContext): Return => {
	const read = request({ pages: Keyed.idle(), nowMs: null, isAdmin: false }, context, "Load")
	return {
		model: read.model,
		commands: [ReadListClock(), FetchListSession({ orgId: context.orgId }), ...(read.commands ?? [])],
	}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchSession: ({ orgId, isAdmin }) =>
			orgId === context.orgId ? { model: { ...model, isAdmin } } : { model },
		CompletedFetchPages: ({ key, result }) => ({
			model: { ...model, pages: Keyed.accept(model.pages, key, result) },
			commands: [ReadListClock()],
		}),
		ClickedRetry: () => request(model, context, "Supersede"),
	})
