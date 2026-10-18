import type { Resources } from "../platform/resources"
import { Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { AppRoute } from "../route"
import type { PageContext, PageOutMessage } from "./contract"
import type { PageViewInputs } from "./kit/inputs"
import * as Traces from "./traces"

// Every page: its Model in the root, its Messages lifted, one entry per route.

/** A route whose page is not ported yet renders nothing. */
export const PlaceholderPage = Schema.TaggedStruct("PlaceholderPage", { route: Schema.String })
export type PlaceholderPage = typeof PlaceholderPage.Type

export const placeholder = (route: string): PlaceholderPage => ({ _tag: "PlaceholderPage", route })

export const PageModel = Schema.Union([Traces.Model, PlaceholderPage])
export type PageModel = typeof PageModel.Type

export const PageMessage = defineMessageUnion({
	GotTracesMessage: { message: Traces.Message },
})
export type PageMessage = typeof PageMessage.Type

type PageReturn = Update.ReturnWithOutMessage<PageModel, PageMessage, PageOutMessage, Resources>

/** The page instance survives while this is unchanged; a search change arrives as `locationChanged`. */
export const pageKeyOf = (route: AppRoute): string => JSON.stringify(route)

export const initPage = (route: AppRoute, context: PageContext): PageReturn =>
	AppRoute.match<PageReturn>(route, {
		Traces: () => {
			const init_ = Traces.init(context)
			return {
				model: init_.model,
				commands: Command.mapMessages(init_.commands, (message) => PageMessage.GotTracesMessage({ message })),
			}
		},
		TraceDetail: () => ({ model: placeholder("TraceDetail") }),
		Logs: () => ({ model: placeholder("Logs") }),
		Metrics: () => ({ model: placeholder("Metrics") }),
		MetricDetail: () => ({ model: placeholder("MetricDetail") }),
		Services: () => ({ model: placeholder("Services") }),
		ServiceDetail: () => ({ model: placeholder("ServiceDetail") }),
		ServiceMap: () => ({ model: placeholder("ServiceMap") }),
		Errors: () => ({ model: placeholder("Errors") }),
		Sessions: () => ({ model: placeholder("Sessions") }),
		SessionDetail: () => ({ model: placeholder("SessionDetail") }),
		Query: () => ({ model: placeholder("Query") }),
	})

const lift = <M>(result: Update.ReturnWithOutMessage<PageModel, M, PageOutMessage, Resources>, toMessage: (message: M) => PageMessage): PageReturn => ({
	model: result.model,
	commands: Command.mapMessages(result.commands ?? [], toMessage),
	outMessage: result.outMessage,
})

export const updatePage = (page: PageModel, message: PageMessage, context: PageContext): PageReturn =>
	PageMessage.match<PageReturn>(message, {
		GotTracesMessage: ({ message: child }) =>
			page._tag === "TracesPage"
				? lift(Traces.update(page, child, context), (next) => PageMessage.GotTracesMessage({ message: next }))
				: { model: page },
	})

export const locationChanged = (page: PageModel, context: PageContext): PageReturn => {
	if (page._tag === "TracesPage")
		return lift(Traces.locationChanged(page, context), (next) => PageMessage.GotTracesMessage({ message: next }))
	return { model: page }
}

export const viewPage = <ParentMessage>(
	h: HtmlBuilder<ParentMessage>,
	page: PageModel,
	inputs: PageViewInputs,
	toParentMessage: (message: PageMessage) => ParentMessage,
): Html => {
	if (page._tag === "TracesPage")
		return h.submodel({
			slotId: "page:traces",
			model: page,
			view: Traces.view,
			viewInputs: inputs,
			toParentMessage: (message: Traces.Message) => toParentMessage(PageMessage.GotTracesMessage({ message })),
		})
	return h.div([], [])
}
