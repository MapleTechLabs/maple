import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import { AppRoute, hrefOf } from "../../../route"
import type { AgentSessionEvalsSearch } from "../../../route/search"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { applySteps, keyed } from "../../kit/keyed-step"
import * as Frame from "../../kit/time-frame"
import { liftFrame, resolveFrame, routeFrame } from "../../kit/time-frame-step"
import { DEFAULT_TOOL_PRESET } from "../../kit/tools/model"
import { FetchEvaluators, Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Search = typeof AgentSessionEvalsSearch.Type

export const DEFAULT_EVALS_PRESET = DEFAULT_TOOL_PRESET

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })

const scopeOf = (search: Search, context: PageContext): Frame.Scope => ({
	search,
	defaultPreset: DEFAULT_EVALS_PRESET,
	timeZone: context.timeZone,
})

const requestAll = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const window = model.frame.window
	if (window === null) return { model }
	const data = { startTime: window.startTime, endTime: window.endTime }
	return applySteps<Model, Message>(model, [
		keyed(
			model.evaluators,
			requestKey(context.orgId, "listAiEvaluators", { data }),
			mode,
			(evaluators) => ({ evaluators }),
			(key) => FetchEvaluators({ key, window }),
		),
	])
}

export const init = (route: { readonly search: Search }, context: PageContext): Return => {
	const model: Model = {
		search: route.search,
		frame: Frame.init("agent-evals-time-range"),
		evaluators: Keyed.idle(),
	}
	return { model, commands: [resolveFrame(model.frame, scopeOf(route.search, context), toFrame, "Load")] }
}

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return =>
	routeFrame(
		model.search,
		{ ...model, search: route.search },
		scopeOf(route.search, context),
		toFrame,
		(next, mode) => requestAll(next, context, mode),
	)

export const contextChanged = (model: Model, context: PageContext): Return =>
	requestAll(model, context, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchEvaluators: ({ key, result }) => ({
			model: { ...model, evaluators: Keyed.accept(model.evaluators, key, result) },
		}),
		ClickedRetry: () => requestAll(model, context, "Refresh"),
		GotFrameMessage: ({ message: inner }) =>
			liftFrame(model, inner, scopeOf(model.search, context), toFrame, {
				onResolved: (next, mode) => requestAll(next, context, mode),
				onTimeSearch: (next, search) => ({
					model: next,
					outMessage: PageOutMessage.RequestedNavigation({
						url: hrefOf(AppRoute.AgentSessionEvals({ search: { ...next.search, ...search } })),
						isReplace: false,
					}),
				}),
			}),
	})
