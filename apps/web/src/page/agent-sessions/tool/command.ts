import { resolveWindowCommand } from "../../kit/time-frame"
import { reloadSpin } from "@maple/views/data/timing"
import { AI_TOOL_ERRORS_MAX } from "@maple/domain/http"
import { getAiSessionsFacets, listAiSessions } from "@maple/web-data/warehouse/ai-sessions"
import { getAiToolErrors, getAiToolSeries } from "@maple/web-data/warehouse/ai-session-tools"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { TimeWindow } from "../../../data/time-range"
import { presentInputs } from "../list/derive"
import { fetchTotals, Selection, toInput } from "../../kit/tools/reads"
import { Message } from "./message"

/** Sessions the page lists: the most recent, not the busiest. */
export const SESSIONS_LIMIT = 50

export const ResolveWindow = resolveWindowCommand("ResolveAgentToolWindow", Message.CompletedResolveWindow)

export const FetchSeries = Command.define("FetchAgentToolSeries", {
	args: { key: Schema.String, selection: Selection, bucketSeconds: Schema.Number },
	messages: [Message.CompletedFetchSeries],
	execute: ({ key, selection, bucketSeconds }) =>
		getAiToolSeries({ data: { ...toInput(selection), bucketSeconds, split: "none" } }).pipe(
			settleTo((result) => Message.CompletedFetchSeries({ key, result })),
		),
})

/** The header states the current window only, so the comparison and population are not asked for. */
export const FetchTotals = Command.define("FetchAgentToolTotals", {
	args: { key: Schema.String, selection: Selection },
	messages: [Message.CompletedFetchTotals],
	execute: ({ key, selection }) =>
		Effect.map(fetchTotals(selection, ["current"]), (result) =>
			Message.CompletedFetchTotals({ key, result }),
		),
})

export const FetchErrors = Command.define("FetchAgentToolErrors", {
	args: { key: Schema.String, selection: Selection, tool: Schema.String, bucketSeconds: Schema.Number },
	messages: [Message.CompletedFetchErrors],
	execute: ({ key, selection, tool, bucketSeconds }) =>
		getAiToolErrors({
			data: { ...toInput(selection), tool, bucketSeconds, limit: AI_TOOL_ERRORS_MAX },
		}).pipe(settleTo((result) => Message.CompletedFetchErrors({ key, result }))),
})

export const SessionsInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	tool: Schema.String,
	service: Schema.UndefinedOr(Schema.String),
	env: Schema.UndefinedOr(Schema.String),
	model: Schema.UndefinedOr(Schema.String),
})

export const FetchSessions = Command.define("FetchAgentToolSessions", {
	args: { key: Schema.String, input: SessionsInput },
	messages: [Message.CompletedFetchSessions],
	execute: ({ key, input }) =>
		listAiSessions({
			data: {
				...presentInputs({
					startTime: input.startTime,
					endTime: input.endTime,
					toolNames: [input.tool],
					serviceNames: input.service === undefined ? undefined : [input.service],
					deploymentEnvs: input.env === undefined ? undefined : [input.env],
					models: input.model === undefined ? undefined : [input.model],
					sortBy: "startTime",
					sortDir: "desc",
				}),
				limit: SESSIONS_LIMIT,
			},
		}).pipe(settleTo((result) => Message.CompletedFetchSessions({ key, result }))),
})

export const FetchFacets = Command.define("FetchAgentToolFacets", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, window }) =>
		getAiSessionsFacets({ data: window }).pipe(
			settleTo((result) => Message.CompletedFetchFacets({ key, result })),
		),
})

export const CompleteReloadSpin = reloadSpin("CompleteAgentToolReloadSpin", Message.CompletedReloadSpin)
