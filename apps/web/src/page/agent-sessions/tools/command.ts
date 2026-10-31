import { getAiSessionsFacets } from "@maple/web-data/warehouse/ai-sessions"
import { getAiToolBreakdowns, getAiToolSeries } from "@maple/web-data/warehouse/ai-session-tools"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { resolveWindow, TimeWindow } from "../../../data/time-range"
import { loadSignalPresences } from "../../kit/signal-presence"
import { fetchTotals, Selection, toInput } from "../tools-kit/reads"
import { Message, RequestMode } from "./message"

export const ResolveWindow = Command.define("ResolveAgentToolsWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.UndefinedOr(Schema.String),
		endTime: Schema.UndefinedOr(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				nowMs,
				mode,
			}),
		),
})

export const FetchSeries = Command.define("FetchAgentToolsSeries", {
	args: { key: Schema.String, selection: Selection, bucketSeconds: Schema.Number, isScope: Schema.Boolean },
	messages: [Message.CompletedFetchSeries, Message.CompletedFetchScopeSeries],
	execute: ({ key, selection, bucketSeconds, isScope }) =>
		getAiToolSeries({
			data: { ...toInput(selection), bucketSeconds, split: isScope ? "none" : undefined },
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) =>
				isScope
					? Message.CompletedFetchScopeSeries({ key, result })
					: Message.CompletedFetchSeries({ key, result }),
			),
		),
})

export const FetchTotals = Command.define("FetchAgentToolsTotals", {
	args: { key: Schema.String, selection: Selection, isTab: Schema.Boolean },
	messages: [Message.CompletedFetchTotals, Message.CompletedFetchTabTotals],
	execute: ({ key, selection, isTab }) =>
		Effect.map(fetchTotals(selection), (result) =>
			isTab
				? Message.CompletedFetchTabTotals({ key, result })
				: Message.CompletedFetchTotals({ key, result }),
		),
})

export const FetchBreakdowns = Command.define("FetchAgentToolsBreakdowns", {
	args: { key: Schema.String, selection: Selection, isTab: Schema.Boolean },
	messages: [Message.CompletedFetchBreakdowns, Message.CompletedFetchTabBreakdowns],
	execute: ({ key, selection, isTab }) =>
		getAiToolBreakdowns({ data: toInput(selection) }).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) =>
				isTab
					? Message.CompletedFetchTabBreakdowns({ key, result })
					: Message.CompletedFetchBreakdowns({ key, result }),
			),
		),
})

export const FetchFacets = Command.define("FetchAgentToolsFacets", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, window }) =>
		getAiSessionsFacets({ data: window }).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFacets({ key, result })),
		),
})

export const DebounceSearch = Command.define("DebounceAgentToolsSearch", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(300)), Message.ElapsedSearchDebounce({ version })),
})

export const LoadSignalPresence = Command.define("LoadAgentToolsSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})

export const CompleteReloadSpin = Command.define("CompleteAgentToolsReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
