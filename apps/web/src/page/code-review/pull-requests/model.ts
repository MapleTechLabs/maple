import {
	CodeReviewAnalytics,
	CodeReviewListResponse,
	CodeReviewSortKey,
	PrReviewId,
} from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { CodeReviewPullRequestsSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import { Frame, FrameMessage } from "../kit/frame"
import { ResponseCache } from "../kit/page-steps"
import { ReviewSheet, SheetMessage } from "../kit/review-sheet"

// `/code-review/pull-requests` and its review sheet.

export const Model = Schema.Struct({
	search: CodeReviewPullRequestsSearch,
	frame: Frame,
	/** `codeReview.listReviews` at `limit` rows. */
	reviews: KeyedSchema(CodeReviewListResponse, LoadFailure),
	reviewsCache: ResponseCache(CodeReviewListResponse),
	/** The filters' author list (`codeReview.analytics` without the author). */
	authors: KeyedSchema(CodeReviewAnalytics, LoadFailure),
	authorsCache: ResponseCache(CodeReviewAnalytics),
	/** `useState(PAGE)`: Load more adds a page; a filter change starts over. */
	limit: Schema.Number,
	statusSelect: Select.Model,
	/** The search box's input and its debounce generation. */
	searchDraft: Schema.String,
	searchGeneration: Schema.Number,
	sheet: ReviewSheet,
})
export type Model = typeof Model.Type

const result = <S extends Schema.Top>(schema: S) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	GotFrameMessage: { message: FrameMessage },
	CompletedFetchReviews: result(CodeReviewListResponse),
	CompletedFetchAuthors: result(CodeReviewAnalytics),
	ClickedRetry: {},
	ClickedClearFilters: {},
	ClickedReview: { reviewId: PrReviewId },
	ClickedLoadMore: {},
	ClickedSort: { key: CodeReviewSortKey },
	TickedPoll: {},
	GotStatusSelectMessage: { message: Select.Message },
	ChangedSearchDraft: { value: Schema.String },
	ElapsedSearchDebounce: { generation: Schema.Number },
	GotSheetMessage: { message: SheetMessage },
})
export type Message = typeof Message.Type
