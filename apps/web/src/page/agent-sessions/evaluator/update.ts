import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import { AppRoute, hrefOf } from "../../../route"
import type { AgentSessionEvaluatorSearch } from "../../../route/search"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { applySteps, keyed } from "../../kit/keyed-step"
import * as Frame from "../../kit/time-frame"
import { liftFrame, resolveFrame, routeFrame } from "../../kit/time-frame-step"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { chartBucketSecondsBetween } from "@maple/views/lib/infra-chart-units"
import { DEFAULT_EVALS_PRESET } from "../evals/update"
import { type DetailInput, FetchDetail, Message } from "./message"
import { scoresWindow } from "../kit/evals"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Search = typeof AgentSessionEvaluatorSearch.Type
type Route = Readonly<{ name: string; search: Search }>

const toFrame = (message: Frame.Message) => Message.GotFrameMessage({ message })

const scopeOf = (search: Search, context: PageContext): Frame.Scope => ({
	search,
	defaultPreset: DEFAULT_EVALS_PRESET,
	timeZone: context.timeZone,
})

const requestAll = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	if (model.frame.window === null) return { model }
	const window = scoresWindow(model.frame.window, model.frame.nowMs)
	const input: DetailInput = {
		startTime: window.startTime,
		endTime: window.endTime,
		name: model.name,
		// The same bucket the tools pages pick for a window.
		bucketSeconds: chartBucketSecondsBetween(toEpochMs(window.startTime), toEpochMs(window.endTime)),
		...(model.search.failing === true && { verdict: "fail" as const }),
	}
	return applySteps<Model, Message>(model, [
		keyed(
			model.detail,
			requestKey(context.orgId, "getAiEvaluator", { data: input }),
			mode,
			(detail) => ({ detail }),
			(key) => FetchDetail({ key, input }),
		),
	])
}

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.AgentSessionEvaluator({ name: model.name, search })),
		isReplace: false,
	}),
})

export const init = (route: Route, context: PageContext): Return => {
	const model: Model = {
		name: route.name,
		search: route.search,
		frame: Frame.init("agent-evaluator-time-range"),
		detail: Keyed.idle(),
	}
	return { model, commands: [resolveFrame(model.frame, scopeOf(route.search, context), toFrame, "Load")] }
}

export const routeChanged = (model: Model, route: Route, context: PageContext): Return =>
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
		CompletedFetchDetail: ({ key, result }) => ({
			model: { ...model, detail: Keyed.accept(model.detail, key, result) },
		}),
		ClickedRetry: () => requestAll(model, context, "Refresh"),
		ToggledFailingOnly: () =>
			navigate(model, { ...model.search, failing: model.search.failing === true ? undefined : true }),
		GotFrameMessage: ({ message: inner }) =>
			liftFrame(model, inner, scopeOf(model.search, context), toFrame, {
				onResolved: (next, mode) => requestAll(next, context, mode),
				onTimeSearch: (next, search) => navigate(next, { ...next.search, ...search }),
			}),
	})
