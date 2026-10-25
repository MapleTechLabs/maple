import { Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import { AppRoute, hrefOf } from "../../../route"
import type { CodeReviewSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { epochWindow } from "../kit/api"
import { type FrameMessage, type FrameOut, type FrameReturn, type RequestMode } from "../kit/frame"
import {
	type Carried,
	frameRetained,
	frameRouteChanged,
	initFrame,
	noCarry,
	updateFrame,
} from "../kit/frame-update"
import type { Retained } from "../kit/retained"
import { cachedStep, mergeSteps, remember } from "../kit/page-steps"
import { FetchAnalytics } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Search = typeof CodeReviewSearch.Type

/** `CODE_REVIEW_DEFAULT_PRESET`: reviews are slow-moving, a month has something in it. */
export const DEFAULT_PRESET = "30d"
const FRAME_ID = "code-review-analytics"


const searchHref = (search: Search) => hrefOf(AppRoute.CodeReview({ search }))

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url: searchHref(search), isReplace: false }),
})

const request = (model: Model, context: PageContext, window: TimeWindow, mode: RequestMode): Return => {
	const base = { ...epochWindow(window), repositoryId: model.search.repo }
	const query = { ...base, author: model.search.author }
	const authorsQuery = { ...base, author: undefined }
	const step = mergeSteps<Model, Message>([
		cachedStep(
			model.cache,
			model.frame.nowMs,
			model.analytics,
			requestKey(context.orgId, "codeReview.analytics", { query }),
			mode,
			(analytics) => ({ analytics }),
			(key) => FetchAnalytics({ key, query }),
		),
		cachedStep(
			model.cache,
			model.frame.nowMs,
			model.authors,
			requestKey(context.orgId, "codeReview.analytics", { query: authorsQuery }),
			mode,
			(authors) => ({ authors }),
			(key) => FetchAnalytics({ key, query: authorsQuery }),
		),
	])
	return { model: { ...model, ...step.patch }, commands: step.commands }
}

const liftFrame = (model: Model, result: FrameReturn, context: PageContext): Return => {
	const next: Model = { ...model, frame: result.frame }
	const commands = Command.mapMessages(result.commands, (message: FrameMessage) =>
		Message.GotFrameMessage({ message }),
	)
	const out = result.out === null ? { model: next } : applyOut(next, result.out, context)
	return { ...out, commands: [...commands, ...(out.commands ?? [])] }
}

const applyOut = (model: Model, out: FrameOut, context: PageContext): Return => {
	switch (out._tag) {
		case "PickedRepository":
			return navigate(model, { ...model.search, repo: out.repo })
		case "PickedOption":
			return navigate(model, { ...model.search, author: out.value })
		case "PickedWindow":
			return navigate(model, { ...model.search, ...out.window })
		case "RefusedWindow":
			return { model, outMessage: out.toast }
		case "ResolvedWindow":
			return request(model, context, out.window, out.mode)
	}
}

// ENTRY POINTS

export const init = (
	route: { readonly search: Search },
	context: PageContext,
	carried: Carried = noCarry,
): Return => {
	const frame = initFrame(FRAME_ID, route.search, route.search.author, DEFAULT_PRESET, context, carried)
	const model: Model = {
		search: route.search,
		frame: frame.frame,
		analytics: Keyed.idle(),
		authors: Keyed.idle(),
		cache: carried.retained.analytics,
		volumeSelect: Select.init(`${FRAME_ID}-volume`, { value: "pullRequests", selectedIndex: null }),
		severitySelect: Select.init(`${FRAME_ID}-severity`, { value: "all", selectedIndex: null }),
		volumeChart: Chart.init(),
		issuesChart: Chart.init(),
		chartRuntime: { _tag: "Loading" },
		themeColors: null,
	}
	const lifted = liftFrame(model, frame, context)
	return {
		...lifted,
		commands: [
			...(lifted.commands ?? []),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

export const routeChanged = (
	model: Model,
	route: { readonly search: Search },
	context: PageContext,
): Return =>
	searchHref(model.search) === searchHref(route.search)
		? { model }
		: liftFrame(
				{ ...model, search: route.search },
				frameRouteChanged(
					model.frame,
					model.search,
					route.search,
					route.search.author,
					DEFAULT_PRESET,
					context,
				),
				context,
			)

export const contextChanged = (model: Model, context: PageContext): Return =>
	model.frame.window === null ? { model } : request(model, context, model.frame.window, "Load")

const liftSelect = (
	select: Select.Model,
	message: Select.Message,
	write: (next: Select.Model) => Model,
	wrap: (inner: Select.Message) => Message,
): Return => {
	const next = Select.update(select, message)
	return { model: write(next.model), commands: Command.mapMessages(next.commands, wrap) }
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		GotFrameMessage: ({ message: inner }) =>
			liftFrame(model, updateFrame(model.frame, inner, model.search, DEFAULT_PRESET, context), context),
		CompletedFetchAnalytics: ({ key, result }) => ({
			model: {
				...model,
				analytics: Keyed.accept(model.analytics, key, result),
				authors: Keyed.accept(model.authors, key, result),
				cache: remember(model.cache, model.frame.nowMs, key, result),
			},
		}),
		ClickedRetry: () =>
			model.frame.window === null ? { model } : request(model, context, model.frame.window, "Refresh"),
		ClickedClearFilters: () => navigate(model, { ...model.search, repo: undefined, author: undefined }),
		GotVolumeSelectMessage: ({ message: inner }) =>
			liftSelect(
				model.volumeSelect,
				inner,
				(volumeSelect) => ({ ...model, volumeSelect }),
				(m) => Message.GotVolumeSelectMessage({ message: m }),
			),
		GotSeveritySelectMessage: ({ message: inner }) =>
			liftSelect(
				model.severitySelect,
				inner,
				(severitySelect) => ({ ...model, severitySelect }),
				(m) => Message.GotSeveritySelectMessage({ message: m }),
			),
		GotChartMessage: ({ chart, message: inner }) => {
			const current = chart === "volume" ? model.volumeChart : model.issuesChart
			const next = Chart.update(current, inner)
			return {
				model:
					chart === "volume"
						? { ...model, volumeChart: next.model }
						: { ...model, issuesChart: next.model },
				commands: Command.mapMessages(next.commands, (m) =>
					Message.GotChartMessage({ chart, message: m }),
				),
			}
		},
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
	})

/** What this tab hands the next one. */
export const retainedOf = (model: Model): Partial<Retained> => ({
	...frameRetained(model.frame),
	analytics: model.cache,
})
