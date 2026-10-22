import { CiRunResult, type CodeReviewCiRunsResponse } from "@maple/domain/http"
import { type Result, Schema } from "effect"
import type { LoadFailure } from "../../../data/load-failure"
import { Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { AppRoute, hrefOf } from "../../../route"
import type { CodeReviewCiSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { ALL, type FrameOut, type FrameReturn } from "../kit/frame"
import {
	type Carried,
	frameRetained,
	frameRouteChanged,
	initFrame,
	noCarry,
	updateFrame,
} from "../kit/frame-update"
import type { Retained } from "../kit/retained"
import { remember } from "../kit/page-steps"
import { Message, type Model } from "./model"
import { followRuns, request, runsPageStep } from "./requests"

export type Search = typeof CodeReviewCiSearch.Type
type Return = PageReturn<Model, Message>

/** `CODE_REVIEW_CI_DEFAULT_PRESET`: CI scans raw traces, a week is the default. */
export const DEFAULT_PRESET = "7d"
const FRAME_ID = "code-review-ci"
const isRunResult = Schema.is(CiRunResult)

const searchHref = (search: Search) => hrefOf(AppRoute.CodeReviewCi({ search }))

const navigate = (model: Model, patch: Partial<Search>): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: searchHref({ ...model.search, ...patch }),
		isReplace: false,
	}),
})

const applyOut = (model: Model, out: FrameOut, context: PageContext): Return => {
	switch (out._tag) {
		case "PickedRepository":
			return navigate(model, { repo: out.repo })
		case "PickedOption":
			return navigate(model, { pipeline: out.value })
		case "PickedWindow":
			return navigate(model, out.window)
		case "RefusedWindow":
			return { model, outMessage: out.toast }
		case "ResolvedWindow":
			return request(model, context, out.window, out.mode)
	}
}

const liftFrame = (model: Model, result: FrameReturn, context: PageContext): Return => {
	const next: Model = { ...model, frame: result.frame }
	const commands = Command.mapMessages(result.commands, (message) => Message.GotFrameMessage({ message }))
	const out = result.out === null ? { model: next } : applyOut(next, result.out, context)
	return { ...out, commands: [...commands, ...(out.commands ?? [])] }
}

export const init = (
	route: { readonly search: Search },
	context: PageContext,
	carried: Carried = noCarry,
): Return => {
	const frame = initFrame(FRAME_ID, route.search, route.search.pipeline, DEFAULT_PRESET, context, carried)
	const model: Model = {
		search: route.search,
		frame: frame.frame,
		analytics: Keyed.idle(),
		pipelines: Keyed.idle(),
		analyticsCache: carried.retained.ciAnalytics,
		runsFilterKey: null,
		runs: Keyed.idle(),
		cursors: [],
		pages: {},
		runsCache: carried.retained.ciRuns,
		resultSelect: Select.init(`${FRAME_ID}-result`, {
			value: route.search.result ?? ALL,
			selectedIndex: null,
		}),
		runsChart: Chart.init(),
		durationChart: Chart.init(),
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
				{
					...model,
					search: route.search,
					resultSelect: { ...model.resultSelect, value: route.search.result ?? ALL },
				},
				frameRouteChanged(
					model.frame,
					model.search,
					route.search,
					route.search.pipeline,
					DEFAULT_PRESET,
					context,
				),
				context,
			)

export const contextChanged = (model: Model, context: PageContext): Return =>
	model.frame.window === null ? { model } : request(model, context, model.frame.window, "Load")

const pageStep = (model: Model, context: PageContext, cursor: string, mode: Keyed.RequestMode): Return => {
	const step = runsPageStep(model, context, cursor, mode)
	return { model: { ...model, ...step.patch }, commands: step.commands }
}

const acceptRuns = (
	model: Model,
	cursor: string | null,
	key: string,
	result: Result.Result<CodeReviewCiRunsResponse, LoadFailure>,
): Model => {
	const runsCache = remember(model.runsCache, model.frame.nowMs, key, result)
	if (cursor === null) return { ...model, runs: Keyed.accept(model.runs, key, result), runsCache }
	const slot = model.pages[cursor]
	return slot === undefined
		? model
		: { ...model, pages: { ...model.pages, [cursor]: Keyed.accept(slot, key, result) }, runsCache }
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		GotFrameMessage: ({ message: inner }) =>
			liftFrame(model, updateFrame(model.frame, inner, model.search, DEFAULT_PRESET, context), context),
		CompletedFetchAnalytics: ({ key, result }) =>
			followRuns(
				{
					...model,
					analytics: Keyed.accept(model.analytics, key, result),
					pipelines: Keyed.accept(model.pipelines, key, result),
					analyticsCache: remember(model.analyticsCache, model.frame.nowMs, key, result),
				},
				context,
			),
		CompletedFetchRuns: ({ cursor, key, result }) => ({ model: acceptRuns(model, cursor, key, result) }),
		ClickedRetry: () =>
			model.frame.window === null ? { model } : request(model, context, model.frame.window, "Refresh"),
		ClickedRetryRuns: () => {
			const step = runsPageStep(model, context, null, "Refresh")
			return { model: { ...model, ...step.patch }, commands: step.commands }
		},
		ClickedRetryPage: ({ cursor }) => pageStep(model, context, cursor, "Refresh"),
		ClickedMoreRuns: ({ cursor }) =>
			model.cursors.includes(cursor)
				? { model }
				: pageStep({ ...model, cursors: [...model.cursors, cursor] }, context, cursor, "Load"),
		ClickedClearFilters: () => navigate(model, { repo: undefined, pipeline: undefined }),
		ClickedClearRunFilters: () => navigate(model, { branch: undefined, result: undefined }),
		ClickedClearBranch: () => navigate(model, { branch: undefined }),
		// `onSelectPipeline(name === pipeline ? undefined : name)`: a second click clears it.
		ClickedWorkflow: ({ pipeline }) =>
			navigate(model, { pipeline: pipeline === model.search.pipeline ? undefined : pipeline }),
		ClickedBranch: ({ branch }) => navigate(model, { branch }),
		ClickedTraceLink: ({ url }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({ url, isReplace: false }),
		}),
		GotResultSelectMessage: ({ message: inner }) => {
			const next = Select.update(model.resultSelect, inner)
			const lifted: Return = {
				model: { ...model, resultSelect: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotResultSelectMessage({ message: m }),
				),
			}
			if (next.outMessage === undefined) return lifted
			const value = next.outMessage.value
			return {
				...lifted,
				outMessage: navigate(lifted.model, { result: isRunResult(value) ? value : undefined })
					.outMessage,
			}
		},
		GotChartMessage: ({ chart, message: inner }) => {
			const next = Chart.update(chart === "runs" ? model.runsChart : model.durationChart, inner)
			return {
				model:
					chart === "runs"
						? { ...model, runsChart: next.model }
						: { ...model, durationChart: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
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
	ciAnalytics: model.analyticsCache,
	ciRuns: model.runsCache,
})
