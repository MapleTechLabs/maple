import {
	CodeReviewCiAnalytics,
	CodeReviewCiQuery,
	CodeReviewCiRunsQuery,
	CodeReviewCiRunsResponse,
} from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "../../../charts/chart"
import { ChartRuntime } from "../../../charts/chart-runtime"
import { ThemeColors } from "../../../charts/theme-colors"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { CodeReviewCiSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import { getCiAnalytics, listCiRuns } from "../kit/api"
import { Frame, FrameMessage } from "../kit/frame"
import { ResponseCache } from "../kit/page-steps"

// `/code-review/ci`.

const RunsPage = KeyedSchema(CodeReviewCiRunsResponse, LoadFailure)

export const Model = Schema.Struct({
	search: CodeReviewCiSearch,
	frame: Frame,
	/** `codeReview.ciAnalytics` for the repository and workflow. */
	analytics: KeyedSchema(CodeReviewCiAnalytics, LoadFailure),
	/** The workflow filter's list: the same read without the workflow. */
	pipelines: KeyedSchema(CodeReviewCiAnalytics, LoadFailure),
	analyticsCache: ResponseCache(CodeReviewCiAnalytics),
	/** `CiRunsList`: the first page, then one slot per cursor followed (each its own read). */
	runsFilterKey: Schema.NullOr(Schema.String),
	runs: RunsPage,
	cursors: Schema.Array(Schema.String),
	pages: Schema.Record(Schema.String, RunsPage),
	runsCache: ResponseCache(CodeReviewCiRunsResponse),
	resultSelect: Select.Model,
	runsChart: Chart.Model,
	durationChart: Chart.Model,
	chartRuntime: ChartRuntime,
	themeColors: Schema.NullOr(ThemeColors),
})
export type Model = typeof Model.Type

const result = <S extends Schema.Top>(schema: S) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	GotFrameMessage: { message: FrameMessage },
	CompletedFetchAnalytics: result(CodeReviewCiAnalytics),
	CompletedFetchRuns: { cursor: Schema.NullOr(Schema.String), ...result(CodeReviewCiRunsResponse) },
	ClickedRetry: {},
	ClickedRetryRuns: {},
	ClickedRetryPage: { cursor: Schema.String },
	ClickedClearFilters: {},
	ClickedClearRunFilters: {},
	ClickedClearBranch: {},
	ClickedWorkflow: { pipeline: Schema.String },
	ClickedBranch: { branch: Schema.String },
	ClickedTraceLink: { url: Schema.String },
	ClickedMoreRuns: { cursor: Schema.String },
	GotResultSelectMessage: { message: Select.Message },
	GotChartMessage: { chart: Schema.Literals(["runs", "duration"]), message: Chart.Message },
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
	ResolvedThemeColors: { colors: ThemeColors },
})
export type Message = typeof Message.Type

export const FetchCiAnalytics = Command.define("FetchCodeReviewCiAnalytics", {
	args: { key: Schema.String, query: CodeReviewCiQuery },
	messages: [Message.CompletedFetchAnalytics],
	execute: ({ key, query }) =>
		getCiAnalytics(query).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchAnalytics({ key, result })),
		),
})

export const FetchCiRuns = Command.define("FetchCodeReviewCiRuns", {
	args: { key: Schema.String, cursor: Schema.NullOr(Schema.String), query: CodeReviewCiRunsQuery },
	messages: [Message.CompletedFetchRuns],
	execute: ({ key, cursor, query }) =>
		listCiRuns(query).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchRuns({ key, cursor, result })),
		),
})

