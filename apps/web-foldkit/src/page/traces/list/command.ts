import {
	getTracesFacets,
	listTraces,
	type ListTracesInput,
	type Trace,
} from "@maple/web-data/warehouse/traces"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command, Mount } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { resolveWindow, TimeWindow } from "../../../data/time-range"
import { TracesSearch } from "../../../route/search"
import { loadSignalPresences } from "../../kit/signal-presence"
import type { Search } from "./derive"
import { Message, RequestMode } from "./message"
import type { TraceRow, TracesPage } from "./model"

/** `useInfiniteTraces`' page size; the first page is the atom, the rest direct fetches. */
export const PAGE_SIZE = 100

/** `useEffectiveTimeRange` / `useTableRefreshTimeRange`: snapped on entry, unsnapped on Reload. */
export const ResolveWindow = Command.define("ResolveTracesWindow", {
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

export const FetchFacets = Command.define("FetchTracesFacets", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, window }) =>
		getTracesFacets({ data: { startTime: window.startTime, endTime: window.endTime } }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFacets({ key, result })),
		),
})

/** `buildQueryParams`: the URL filters and window, the org pin overriding URL namespaces. */
export const listInput = (
	search: Search,
	window: TimeWindow,
	pinnedNamespace: string | null,
	offset: number,
): ListTracesInput => {
	const isPinned = pinnedNamespace !== null
	return {
		services: search.services,
		spanNames: search.spanNames,
		hasError: search.hasError,
		minDurationMs: search.minDurationMs,
		maxDurationMs: search.maxDurationMs,
		httpMethods: search.httpMethods,
		httpStatusCodes: search.httpStatusCodes,
		deploymentEnvs: search.deploymentEnvs,
		namespaces: isPinned ? [pinnedNamespace] : search.namespaces,
		attributeFilters: search.attributeFilters,
		resourceAttributeFilters: search.resourceAttributeFilters,
		startTime: window.startTime,
		endTime: window.endTime,
		rootOnly: search.rootOnly,
		serviceMatchMode: search.serviceMatchMode,
		spanNameMatchMode: search.spanNameMatchMode,
		deploymentEnvMatchMode: search.deploymentEnvMatchMode,
		namespaceMatchMode: isPinned ? undefined : search.namespaceMatchMode,
		excludedServices: search.excludedServices,
		excludedSpanNames: search.excludedSpanNames,
		excludedDeploymentEnvs: search.excludedDeploymentEnvs,
		excludedNamespaces: isPinned ? undefined : search.excludedNamespaces,
		excludedHttpMethods: search.excludedHttpMethods,
		excludedHttpStatusCodes: search.excludedHttpStatusCodes,
		hideNoise: search.hideNoise,
		minSpanCount: search.minSpanCount,
		sortBy: search.sortBy,
		sortDir: search.sortDir,
		limit: PAGE_SIZE,
		offset,
	}
}

const toRow = (trace: Trace): TraceRow => ({
	traceId: trace.traceId,
	spanId: trace.spanId,
	isRootSpan: trace.isRootSpan,
	startTime: trace.startTime,
	durationMs: trace.durationMs,
	spanCount: trace.spanCount,
	services: trace.services,
	rootSpanName: trace.rootSpanName,
	rootName: trace.rootSpan.name,
	rootKind: trace.rootSpan.kind,
	rootAttributes: trace.rootSpan.attributes,
	httpStatusCode: trace.rootSpan.http?.statusCode ?? null,
	hasError: trace.hasError,
})

const fetchPage = (search: Search, window: TimeWindow, pinnedNamespace: string | null, offset: number) =>
	listTraces({ data: listInput(search, window, pinnedNamespace, offset) }).pipe(
		Effect.map((response): TracesPage => ({
			rows: response.data.map(toRow),
			scannedCount: response.meta.scannedCount,
			hiddenCount: response.meta.hiddenCount,
		})),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

const PageArgs = {
	key: Schema.String,
	search: TracesSearch,
	window: TimeWindow,
	pinnedNamespace: Schema.NullOr(Schema.String),
}

export const FetchFirstPage = Command.define("FetchTracesFirstPage", {
	args: PageArgs,
	messages: [Message.CompletedFetchFirstPage],
	execute: ({ key, search, window, pinnedNamespace }) =>
		Effect.map(fetchPage(search, window, pinnedNamespace, 0), (result) =>
			Message.CompletedFetchFirstPage({ key, result }),
		),
})

/** `fetchNextPage`: offset counts warehouse rows consumed, a page per page. */
export const FetchNextPage = Command.define("FetchTracesNextPage", {
	args: { ...PageArgs, offset: Schema.Number },
	messages: [Message.CompletedFetchNextPage],
	execute: ({ key, search, window, pinnedNamespace, offset }) =>
		Effect.map(fetchPage(search, window, pinnedNamespace, offset), (result) =>
			Message.CompletedFetchNextPage({ key, result }),
		),
})

export const LoadSignalPresence = Command.define("LoadTracesSignalPresence", {
	messages: [Message.CompletedLoadSignalPresence],
	execute: Effect.map(loadSignalPresences, (result) => Message.CompletedLoadSignalPresence({ result })),
})

/** The empty state is on screen: resolves after the frame that painted it. */
export const MountEmptyState = Mount.define("MountTracesEmptyState", {
	messages: [Message.PaintedEmptyState],
	execute: () =>
		Effect.callback<ReturnType<typeof Message.PaintedEmptyState>>((resume) => {
			const handle = requestAnimationFrame(() =>
				requestAnimationFrame(() => resume(Effect.succeed(Message.PaintedEmptyState()))),
			)
			return Effect.sync(() => cancelAnimationFrame(handle))
		}),
})

/** `RangeFilterSection`'s 400 ms pause before typed values commit. */
export const WaitDurationDebounce = Command.define("WaitTracesDurationDebounce", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedDurationDebounce],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(400)), Message.ElapsedDurationDebounce({ version })),
})

export const CompleteReloadSpin = Command.define("CompleteTracesReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
