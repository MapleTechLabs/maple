import { CodeReviewAnalyticsQuery, CodeReviewListQuery } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { getAnalytics, listReviews } from "../kit/api"
import { Message } from "./model"

export const FetchReviews = Command.define("FetchCodeReviewReviews", {
	args: { key: Schema.String, query: CodeReviewListQuery },
	messages: [Message.CompletedFetchReviews],
	execute: ({ key, query }) =>
		listReviews(query).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchReviews({ key, result })),
		),
})

/** The author filter's list: `codeReview.analytics` without the author. */
export const FetchReviewAuthors = Command.define("FetchCodeReviewReviewAuthors", {
	args: { key: Schema.String, query: CodeReviewAnalyticsQuery },
	messages: [Message.CompletedFetchAuthors],
	execute: ({ key, query }) =>
		getAnalytics(query).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchAuthors({ key, result })),
		),
})

