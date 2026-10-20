import type { CodeReviewCiRunsResponse } from "@maple/domain/http"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import * as Keyed from "../../../data/keyed"
import type { LoadFailure } from "../../../data/load-failure"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import type { PageContext, PageReturn } from "../../contract"
import { epochWindow } from "../kit/api"
import { cachedStep, mergeSteps } from "../kit/page-steps"
import { FetchCiAnalytics, FetchCiRuns, type Message, type Model } from "./model"

// The CI tab's reads: analytics and the workflow list, then the runs once the analytics show.

type Return = PageReturn<Model, Message>

/** `PAGE` in `CiRunsList`. */
export const RUNS_PAGE = 50

const runsFilterOf = (model: Model, window: TimeWindow) => ({
	...epochWindow(window),
	repositoryId: model.search.repo,
	pipeline: model.search.pipeline,
	branch: model.search.branch,
	result: model.search.result,
})

const isEmpty = (model: Model) =>
	Option.match(AsyncData.getData(model.analytics.data), {
		onNone: () => true,
		onSome: (analytics) => analytics.current.runs === 0 && analytics.pipelines.length === 0,
	})

/** The runs page under `cursor` (`null` is the first). */
export const runsPageStep = (
	model: Model,
	context: PageContext,
	cursor: string | null,
	mode: Keyed.RequestMode,
) => {
	const window = model.frame.window
	if (window === null) return { patch: {}, commands: [], keys: [] }
	const filter = runsFilterOf(model, window)
	const query = cursor === null ? { ...filter, limit: RUNS_PAGE } : { ...filter, limit: RUNS_PAGE, cursor }
	return cachedStep<Model, Message, CodeReviewCiRunsResponse, LoadFailure>(
		model.runsCache,
		model.frame.nowMs,
		cursor === null ? model.runs : (model.pages[cursor] ?? Keyed.idle()),
		requestKey(context.orgId, "codeReview.ciRuns", { query }),
		mode,
		(next) => (cursor === null ? { runs: next } : { pages: { ...model.pages, [cursor]: next } }),
		(key) => FetchCiRuns({ key, cursor, query }),
	)
}

/** `<CiRunsList key={JSON.stringify(runsFilter)}>`: mounted with the analytics; a new filter starts over. */
export const followRuns = (model: Model, context: PageContext): Return => {
	const window = model.frame.window
	if (window === null || isEmpty(model)) return { model }
	const filterKey = JSON.stringify(runsFilterOf(model, window))
	const base: Model =
		filterKey === model.runsFilterKey
			? model
			: { ...model, runsFilterKey: filterKey, runs: Keyed.idle(), cursors: [], pages: {} }
	const step = runsPageStep(base, context, null, "Load")
	return { model: { ...base, ...step.patch }, commands: step.commands }
}

export const request = (
	model: Model,
	context: PageContext,
	window: TimeWindow,
	mode: Keyed.RequestMode,
): Return => {
	const base = { ...epochWindow(window), repositoryId: model.search.repo }
	const query = { ...base, pipeline: model.search.pipeline }
	const listQuery = { ...base, pipeline: undefined }
	const step = mergeSteps<Model, Message>([
		cachedStep(
			model.analyticsCache,
			model.frame.nowMs,
			model.analytics,
			requestKey(context.orgId, "codeReview.ciAnalytics", { query }),
			mode,
			(analytics) => ({ analytics }),
			(key) => FetchCiAnalytics({ key, query }),
		),
		cachedStep(
			model.analyticsCache,
			model.frame.nowMs,
			model.pipelines,
			requestKey(context.orgId, "codeReview.ciAnalytics", { query: listQuery }),
			"Load",
			(pipelines) => ({ pipelines }),
			(key) => FetchCiAnalytics({ key, query: listQuery }),
		),
	])
	const next = followRuns({ ...model, ...step.patch }, context)
	return { model: next.model, commands: [...step.commands, ...(next.commands ?? [])] }
}
