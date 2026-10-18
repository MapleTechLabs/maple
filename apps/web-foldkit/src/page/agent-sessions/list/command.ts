import { AI_SESSION_DETAILS_MAX_SESSIONS } from "@maple/domain/http"
import {
	getAiSessionDetails,
	getAiSessionsDistributions,
	getAiSessionsFacets,
	listAiSessions,
} from "@maple/web-data/warehouse/ai-sessions"
import { getAiToolBreakdowns, getAiToolTotals } from "@maple/web-data/warehouse/ai-session-tools"
import { Clock, Duration, Effect, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { resolveWindow, TimeWindow } from "../../../data/time-range"
import { AgentSessionsSearch } from "../../../route/search"
import { loadSignalPresences } from "../../kit/signal-presence"
import { detectModels } from "../kit/detected-models"
import { virtualize } from "../kit/virtualize"
import { countedFilters, filterInputs, PAGE_SIZE, presentInputs } from "./derive"
import { Message, RequestMode } from "./message"
import { RangeKey } from "./model"

/** The list's window: no picker, the last week (`AGENT_SESSIONS_WINDOW`). */
export const AGENT_SESSIONS_WINDOW = "7d"

/** The list's own week (unsnapped) and the tab counts' (the Tools tab's snapped default). */
export const ResolveWindow = Command.define("ResolveAgentSessionsWindow", {
	args: { mode: RequestMode, timeZone: Schema.String },
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ preset: AGENT_SESSIONS_WINDOW, snap: false, timeZone }, nowMs),
				tabWindow: resolveWindow({ preset: AGENT_SESSIONS_WINDOW, snap: true, timeZone }, nowMs),
				nowMs,
				mode,
			}),
		),
})

const fetchPage = (search: typeof AgentSessionsSearch.Type, window: TimeWindow, offset: number) =>
	listAiSessions({
		data: { ...presentInputs(filterInputs(search, window)), limit: PAGE_SIZE, offset },
	}).pipe(
		Effect.map((response) => ({ data: response.data, ranked: response.data.length })),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

const pageArgs = { key: Schema.String, search: AgentSessionsSearch, window: TimeWindow }

export const FetchFirstPage = Command.define("FetchAgentSessionsFirstPage", {
	args: pageArgs,
	messages: [Message.CompletedFetchFirstPage],
	execute: ({ key, search, window }) =>
		Effect.map(fetchPage(search, window, 0), (result) =>
			Message.CompletedFetchFirstPage({ key, result }),
		),
})

/** The next page, at the offset the server ranked so far; `key` is the filter key it belongs to. */
export const FetchNextPage = Command.define("FetchAgentSessionsNextPage", {
	args: { ...pageArgs, offset: Schema.Number },
	messages: [Message.CompletedFetchNextPage],
	execute: ({ key, search, window, offset }) =>
		Effect.map(fetchPage(search, window, offset), (result) =>
			Message.CompletedFetchNextPage({ key, offset, result }),
		),
})

/** One page's details, over the page's own extent (fixed-width literals, so string order is time order). */
export const FetchDetails = Command.define("FetchAgentSessionDetails", {
	args: {
		detailsKey: Schema.String,
		search: AgentSessionsSearch,
		window: TimeWindow,
		rows: Schema.Array(
			Schema.Struct({ sessionId: Schema.String, startTime: Schema.String, endTime: Schema.String }),
		),
	},
	messages: [Message.CompletedFetchDetails],
	execute: ({ detailsKey, search, window, rows }) =>
		getAiSessionDetails({
			data: {
				startTime: rows.map((row) => row.startTime).reduce((a, b) => (a < b ? a : b)),
				endTime: rows.map((row) => row.endTime).reduce((a, b) => (a < b ? b : a)),
				sessionIds: rows.map((row) => row.sessionId),
				...countedFilters(filterInputs(search, window)),
			},
		}).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) =>
				Message.CompletedFetchDetails({
					detailsKey,
					sessionIds: rows.map((row) => row.sessionId),
					result,
				}),
			),
		),
})

export const DETAILS_CHUNK = AI_SESSION_DETAILS_MAX_SESSIONS

export const FetchFacets = Command.define("FetchAgentSessionsFacets", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, window }) =>
		getAiSessionsFacets({ data: window }).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFacets({ key, result })),
		),
})

export const FetchDistributions = Command.define("FetchAgentSessionsDistributions", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchDistributions],
	execute: ({ key, window }) =>
		getAiSessionsDistributions({ data: window }).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchDistributions({ key, result })),
		),
})

/** `useAgentSessionsTabCounts`: the window's sessions and the tools called in it. */
export const FetchTabSessions = Command.define("FetchAgentSessionsTabSessions", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchTabSessions],
	execute: ({ key, window }) =>
		getAiToolTotals({ data: window }).pipe(
			Effect.map((totals) => totals.allSessions),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchTabSessions({ key, result })),
		),
})

export const FetchTabTools = Command.define("FetchAgentSessionsTabTools", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchTabTools],
	execute: ({ key, window }) =>
		getAiToolBreakdowns({ data: window }).pipe(
			Effect.map((breakdowns) => breakdowns.tools.length),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchTabTools({ key, result })),
		),
})

export const DetectModels = Command.define("DetectAgentSessionsModels", {
	args: { key: Schema.String },
	messages: [Message.CompletedDetectModels],
	execute: ({ key }) =>
		Effect.map(detectModels(key), (models) => Message.CompletedDetectModels({ key, models })),
})

export const DebounceSearch = Command.define("DebounceAgentSessionsSearch", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(300)), Message.ElapsedSearchDebounce({ version })),
})

export const DebounceRange = Command.define("DebounceAgentSessionsRange", {
	args: { range: RangeKey, version: Schema.Number },
	messages: [Message.ElapsedRangeDebounce],
	execute: ({ range, version }) =>
		Effect.as(Effect.sleep(Duration.millis(400)), Message.ElapsedRangeDebounce({ range, version })),
})

export const CompleteReloadSpin = Command.define("CompleteAgentSessionsReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

const afterPaint = <A>(message: A) =>
	Effect.callback<A>((resume) => {
		const handle = requestAnimationFrame(() =>
			requestAnimationFrame(() => resume(Effect.succeed(message))),
		)
		return Effect.sync(() => cancelAnimationFrame(handle))
	})

/** The loaded table is on screen: its details read follows (`useInfiniteAiSessions`' effect). */
export const MountTable = Mount.define("MountAgentSessionsTable", {
	messages: [Message.PaintedTable],
	execute: () => afterPaint(Message.PaintedTable()),
})

/** `useVirtualizer` over the page scroller, on the table body: measured rows, index keys. */
export const VirtualizeSessions = Mount.defineStream("VirtualizeAgentSessions", {
	messages: [Message.ChangedListWindow],
	execute: ({ element, viewStateChanges }) =>
		viewStateChanges.pipe(
			Stream.switchMap((viewState) =>
				viewState === "Live" && element instanceof HTMLElement
					? virtualize(element, { overscan: 10, isMeasured: true, rows: ":scope > tr[data-index]" }, (window) =>
							Message.ChangedListWindow({ window }),
						)
					: Stream.never,
			),
		),
})

/** The empty state is on screen: `useSignalPresence` mounts with it. */
export const MountEmptyState = Mount.define("MountAgentSessionsEmptyState", {
	messages: [Message.PaintedEmptyState],
	execute: () => afterPaint(Message.PaintedEmptyState()),
})

export const LoadSignalPresence = Command.define("LoadAgentSessionsSignalPresence", {
	messages: [Message.CompletedLoadSignalPresence],
	execute: Effect.map(loadSignalPresences, (result) => Message.CompletedLoadSignalPresence({ result })),
})

/** `ReachEndSentinel`: the 1px marker nearing view (400px margin) asks for the next page. */
export const MountReachEnd = Mount.defineStream("MountAgentSessionsReachEnd", {
	messages: [Message.ReachedListEnd],
	execute: ({ element }) =>
		Stream.callback<ReturnType<typeof Message.ReachedListEnd>>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const observer = new IntersectionObserver(
						(entries) => {
							if (entries[0]?.isIntersecting === true)
								Queue.offerUnsafe(queue, Message.ReachedListEnd())
						},
						{ rootMargin: "400px 0px" },
					)
					observer.observe(element)
					return observer
				}),
				(observer) => Effect.sync(() => observer.disconnect()),
			),
		),
})
