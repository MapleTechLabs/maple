import { getReplaysFacets, listReplays, type ListReplaysInput } from "@maple/web-data/warehouse/replays"
import { sessionTagsFromSearch } from "../../../components/replays/session-tags"
import { Clock, Duration, Effect, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { IdleTtl } from "../../../data/idle-ttl"
import { toLoadFailure } from "../../../data/load-failure"
import { readThrough } from "../../../data/read-cache"
import { resolveWindow, TimeWindow } from "../../../data/time-range"
import { ReplaysSearch } from "../../../route/search"
import { loadSignalPresences } from "../../kit/signal-presence"
import { virtualizeSessions } from "../kit/virtualize"
import { Message, RequestMode } from "./message"
import { ReplaysFacets, ReplaysPage, type Search } from "./model"

/** `REPLAYS_PAGE_SIZE`. */
export const PAGE_SIZE = 50

/** `replaysFilterInputs`: the window and the URL filters, seconds mapped to ms. */
export const filterInputs = (search: Search, window: TimeWindow) => ({
	startTime: window.startTime,
	endTime: window.endTime,
	serviceName: search.service,
	browser: search.browser,
	country: search.country,
	deviceType: search.deviceType,
	userId: search.userId,
	userSearch: search.user,
	groupName: search.group,
	groupId: search.groupId,
	visitorId: search.visitorId,
	hasErrors: search.hasErrors,
	search: search.q,
	pagePath: search.page,
	tags: sessionTagsFromSearch(search.tags),
	durationMinMs: search.durationMin !== undefined ? search.durationMin * 1000 : undefined,
	durationMaxMs: search.durationMax !== undefined ? search.durationMax * 1000 : undefined,
	activeTimeMinMs: search.activeMin !== undefined ? search.activeMin * 1000 : undefined,
	activeTimeMaxMs: search.activeMax !== undefined ? search.activeMax * 1000 : undefined,
})

export const ResolveWindow = Command.define("ResolveReplaysWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
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

const listPage = (input: ListReplaysInput) =>
	Effect.map(listReplays({ data: input }), (page): ReplaysPage => ({
		rows: page.data,
		hasMore: page.hasMore,
		nextCursor: page.nextCursor,
	}))

const fetchPage = (input: ListReplaysInput) =>
	listPage(input).pipe(Effect.mapError(toLoadFailure), Effect.result)

const PageArgs = { key: Schema.String, search: ReplaysSearch, window: TimeWindow }

export const FetchFirstPage = Command.define("FetchReplaysFirstPage", {
	args: { ...PageArgs, refresh: Schema.Boolean },
	messages: [Message.CompletedFetchFirstPage],
	execute: ({ key, refresh, search, window }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.listReplays, schema: ReplaysPage },
			listPage({ ...filterInputs(search, window), limit: PAGE_SIZE }),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFirstPage({ key, result })),
		),
})

/** `fetchNextPage`: the cursor the last page handed back. */
export const FetchNextPage = Command.define("FetchReplaysNextPage", {
	args: { ...PageArgs, cursor: Schema.String, generation: Schema.Number },
	messages: [Message.CompletedFetchNextPage],
	execute: ({ key, search, window, cursor, generation }) =>
		Effect.map(fetchPage({ ...filterInputs(search, window), limit: PAGE_SIZE, cursor }), (result) =>
			Message.CompletedFetchNextPage({ key, generation, cursor, result }),
		),
})

export const FetchFacets = Command.define("FetchReplaysFacets", {
	args: { ...PageArgs, refresh: Schema.Boolean },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, refresh, search, window }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.replaysFacets, schema: ReplaysFacets },
			getReplaysFacets({ data: filterInputs(search, window) }),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFacets({ key, result })),
		),
})

export const LoadSignalPresence = Command.define("LoadReplaysSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})

/** `ReachEndSentinel`: the 1px marker under the list came within 400 px of the viewport. */
export const WatchListEnd = Mount.defineStream("WatchReplaysListEnd", {
	messages: [Message.ReachedListEnd],
	execute: ({ element }) =>
		Stream.callback<typeof Message.ReachedListEnd.Type>((queue) =>
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
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

/** `useVirtualizer` over the page scroller: the rows to render and where. */
export const VirtualizeList = Mount.defineStream("VirtualizeReplaysList", {
	messages: [Message.ChangedVirtualWindow],
	execute: ({ element }) =>
		element instanceof HTMLElement
			? virtualizeSessions(element, (window) => Message.ChangedVirtualWindow({ window }))
			: Stream.never,
})

/** `ToolbarSearch`'s 300 ms debounce. */
export const DebounceQuery = Command.define("DebounceReplaysQuery", {
	args: { generation: Schema.Number },
	messages: [Message.CompletedQueryDebounce],
	execute: ({ generation }) =>
		Effect.as(Effect.sleep(Duration.millis(300)), Message.CompletedQueryDebounce({ generation })),
})

/** `RangeFilterSection`'s 400 ms pause before typed values commit. */
export const DebounceDraft = Command.define("DebounceReplaysRangeDraft", {
	args: { version: Schema.Number },
	messages: [Message.CompletedDraftDebounce],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(400)), Message.CompletedDraftDebounce({ version })),
})

export const CompleteReloadSpin = Command.define("CompleteReplaysReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
