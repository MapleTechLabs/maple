import { Mount } from "foldkit"
import { autoRetryStream } from "../kit/auto-retry"
import { CodeReviewAnalyticsQuery } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { getAnalytics } from "../kit/api"
import { Message } from "./message"

/** `retainedInternalQuery("codeReview", "analytics")`: the page's read and the filters' author list. */
export const FetchAnalytics = Command.define("FetchCodeReviewAnalytics", {
	args: { key: Schema.String, query: CodeReviewAnalyticsQuery },
	messages: [Message.CompletedFetchAnalytics],
	execute: ({ key, query }) =>
		getAnalytics(query).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchAnalytics({ key, result })),
		),
})

/** `ErrorState`'s auto retry while a retryable failure is on screen. */
export const MountAnalyticsAutoRetry = Mount.defineStream("MountAnalyticsAutoRetry", {
	messages: [Message.ClickedRetry],
	execute: () => autoRetryStream(() => Message.ClickedRetry()),
})
