import {
	CodeReviewAnalytics,
	CodeReviewAnalyticsQuery,
	CodeReviewFindingsQuery,
	CodeReviewFindingsResponse,
	PrReviewId,
} from "@maple/domain/http"
import { Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { CodeReviewIssuesSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import * as Tooltip from "../../../ui/tooltip"
import { getAnalytics, listFindings } from "../kit/api"
import { Frame, FrameMessage } from "../kit/frame"
import { ResponseCache } from "../kit/page-steps"
import { ReviewSheet, SheetMessage } from "../kit/review-sheet"
import { SEARCH_DEBOUNCE_MS } from "../kit/search"

// `/code-review/issues`: findings, their filters and the review sheet.

export const FilterKey = Schema.Literals(["severity", "category", "state"])
export type FilterKey = typeof FilterKey.Type

export const Model = Schema.Struct({
	search: CodeReviewIssuesSearch,
	frame: Frame,
	findings: KeyedSchema(CodeReviewFindingsResponse, LoadFailure),
	findingsCache: ResponseCache(CodeReviewFindingsResponse),
	authors: KeyedSchema(CodeReviewAnalytics, LoadFailure),
	authorsCache: ResponseCache(CodeReviewAnalytics),
	limit: Schema.Number,
	severitySelect: Select.Model,
	categorySelect: Select.Model,
	stateSelect: Select.Model,
	/** The search box's input and its debounce generation. */
	searchDraft: Schema.String,
	searchGeneration: Schema.Number,
	/** One Tooltip for every row's relative time (the absolute time). */
	timeTooltip: Tooltip.Model,
	sheet: ReviewSheet,
})
export type Model = typeof Model.Type

const result = <S extends Schema.Top>(schema: S) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	GotFrameMessage: { message: FrameMessage },
	CompletedFetchFindings: result(CodeReviewFindingsResponse),
	CompletedFetchAuthors: result(CodeReviewAnalytics),
	ClickedRetry: {},
	ClickedClearFilters: {},
	ClickedFinding: { reviewId: PrReviewId },
	ClickedLoadMore: {},
	GotFilterSelectMessage: { filter: FilterKey, message: Select.Message },
	GotTimeTooltipMessage: { message: Tooltip.Message },
	ChangedSearchDraft: { value: Schema.String },
	ElapsedSearchDebounce: { generation: Schema.Number },
	GotSheetMessage: { message: SheetMessage },
})
export type Message = typeof Message.Type

export const FetchFindings = Command.define("FetchCodeReviewFindings", {
	args: { key: Schema.String, query: CodeReviewFindingsQuery },
	messages: [Message.CompletedFetchFindings],
	execute: ({ key, query }) =>
		listFindings(query).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFindings({ key, result })),
		),
})

export const FetchFindingAuthors = Command.define("FetchCodeReviewFindingAuthors", {
	args: { key: Schema.String, query: CodeReviewAnalyticsQuery },
	messages: [Message.CompletedFetchAuthors],
	execute: ({ key, query }) =>
		getAnalytics(query).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchAuthors({ key, result })),
		),
})

/** The search box's debounce; a newer keystroke bumps the generation. */
export const WaitSearchDebounce = Command.define("WaitCodeReviewIssuesSearchDebounce", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ generation }) =>
		Effect.as(
			Effect.sleep(Duration.millis(SEARCH_DEBOUNCE_MS)),
			Message.ElapsedSearchDebounce({ generation }),
		),
})
