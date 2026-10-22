import {
	CodeReviewCiRunsQuery,
	CodeReviewCiRunsResponse,
	CodeReviewDetail,
	PrReviewId,
} from "@maple/domain/http"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"
import { getReview, listCiRuns } from "./api"
import { ResponseCache } from "./page-steps"

// `ReviewDetailSheet` with its `PullRequestCiRuns`:
// one review opened from a list, driven by the route's `review` param.

export const ReviewSheet = Schema.Struct({
	dialog: Dialog.Model,
	/** The route's `review`; the sheet shows it while set. */
	reviewId: Schema.NullOr(PrReviewId),
	detail: KeyedSchema(CodeReviewDetail, LoadFailure),
	detailCache: ResponseCache(CodeReviewDetail),
	/** The pull request's runs over two weeks up to `ciNowMs` (read once the detail is in). */
	ciRuns: KeyedSchema(CodeReviewCiRunsResponse, LoadFailure),
	ciCache: ResponseCache(CodeReviewCiRunsResponse),
	nowMs: Schema.Number,
})
export type ReviewSheet = typeof ReviewSheet.Type

export const SheetMessage = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	CompletedFetchDetail: { key: Schema.String, result: Schema.Result(CodeReviewDetail, LoadFailure) },
	ReadCiClock: { key: Schema.String, nowMs: Schema.Number },
	CompletedFetchCiRuns: {
		key: Schema.String,
		result: Schema.Result(CodeReviewCiRunsResponse, LoadFailure),
	},
	ClickedRetry: {},
	ClickedHistoryEntry: { reviewId: PrReviewId },
})
export type SheetMessage = typeof SheetMessage.Type

/** What the sheet asks of the page: the route's `review` changes. */
export type SheetOut =
	| Readonly<{ _tag: "Dismissed" }>
	| Readonly<{ _tag: "SelectedReview"; reviewId: PrReviewId }>

export const FetchReviewDetail = Command.define("FetchCodeReviewDetail", {
	args: { key: Schema.String, reviewId: PrReviewId },
	messages: [SheetMessage.CompletedFetchDetail],
	execute: ({ key, reviewId }) =>
		getReview(reviewId).pipe(
			Effect.result,
			Effect.map((result) => SheetMessage.CompletedFetchDetail({ key, result })),
		),
})

/** `useState(() => Date.now())` in `PullRequestCiRuns`, read when the runs mount. */
export const ReadCiClock = Command.define("ReadCodeReviewCiClock", {
	args: { key: Schema.String },
	messages: [SheetMessage.ReadCiClock],
	execute: ({ key }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) => SheetMessage.ReadCiClock({ key, nowMs })),
})

export const FetchPullRequestRuns = Command.define("FetchCodeReviewPullRequestRuns", {
	args: { key: Schema.String, query: CodeReviewCiRunsQuery },
	messages: [SheetMessage.CompletedFetchCiRuns],
	execute: ({ key, query }) =>
		listCiRuns(query).pipe(
			Effect.result,
			Effect.map((result) => SheetMessage.CompletedFetchCiRuns({ key, result })),
		),
})

