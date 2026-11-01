import { CodeReviewTeam, CodeReviewTeamQuery } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import { CodeReviewTeamSearch, CodeReviewTeamSort } from "../../../route/search"
import { getTeam } from "../kit/api"
import { Frame, FrameMessage } from "../kit/frame"
import { ResponseCache } from "../kit/page-steps"

// `/code-review/team`.

export const Model = Schema.Struct({
	search: CodeReviewTeamSearch,
	frame: Frame,
	/** `codeReview.team` for the repository and window. */
	team: KeyedSchema(CodeReviewTeam, LoadFailure),
	teamCache: ResponseCache(CodeReviewTeam),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotFrameMessage: { message: FrameMessage },
	CompletedFetchTeam: { key: Schema.String, result: Schema.Result(CodeReviewTeam, LoadFailure) },
	ClickedRetry: {},
	ClickedClearFilters: {},
	ClickedSort: { sort: CodeReviewTeamSort },
	SelectedView: { view: Schema.Literals(["scorecard", "ranked"]) },
})
export type Message = typeof Message.Type

export const FetchTeam = Command.define("FetchCodeReviewTeam", {
	args: { key: Schema.String, query: CodeReviewTeamQuery },
	messages: [Message.CompletedFetchTeam],
	execute: ({ key, query }) =>
		getTeam(query).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchTeam({ key, result })),
		),
})
