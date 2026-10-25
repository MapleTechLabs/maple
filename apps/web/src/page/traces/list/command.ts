import {
	getTracesFacets,
	listTraces,
	type ListTracesInput,
	type Trace,
} from "@maple/web-data/warehouse/traces"
import { Clock, Duration, Effect, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { IdleTtl } from "../../../data/idle-ttl"
import { toLoadFailure } from "../../../data/load-failure"
import { readThrough } from "../../../data/read-cache"
import { resolveWindow, TimeWindow } from "../../../data/time-range"
import { TracesSearch } from "../../../route/search"
import { portalToBody } from "../../../ui/overlay/portal"
import { autocompleteLookup, AutocompleteLookup } from "../../kit/autocomplete-lookups"
import { loadSignalPresences } from "../../kit/signal-presence"
import type { Search } from "./derive"
import { Message, RequestMode } from "./message"
import { type TraceRow, TracesFacets, type TracesPage } from "./model"

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
				timeZone,
			}),
		),
})

export const FetchFacets = Command.define("FetchTracesFacets", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, window }) =>
		readThrough(
			{ key, idleTtlMs: IdleTtl.tracesFacets, schema: TracesFacets },
			Effect.map(
				getTracesFacets({ data: { startTime: window.startTime, endTime: window.endTime } }),
				(response) => response.data,
			),
		).pipe(
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
	args: { ...PageArgs, offset: Schema.Number, generation: Schema.Number },
	messages: [Message.CompletedFetchNextPage],
	execute: ({ key, search, window, pinnedNamespace, offset, generation }) =>
		Effect.map(fetchPage(search, window, pinnedNamespace, offset), (result) =>
			Message.CompletedFetchNextPage({ key, generation, offset, result }),
		),
})

export const LoadSignalPresence = Command.define("LoadTracesSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
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

/** `useIsMobile`'s query (the shell's `MOBILE_QUERY`, which reads `window` as it loads). */
export const MOBILE_QUERY = "(max-width: 767px)"

/**
 * `onPeek`: a plain click on a row's stretched link peeks; a modified, middle or right click still
 * follows it. Foldkit links route through a document listener that skips a prevented click.
 */
export const MountPeekRows = Mount.defineStream("MountTracesPeekRows", {
	messages: [Message.ClickedPeekRow],
	execute: ({ element }) =>
		Stream.callback<typeof Message.ClickedPeekRow.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const onClick = (event: Event) => {
						if (!(event instanceof MouseEvent)) return
						const isPlain =
							event.button === 0 &&
							!event.metaKey &&
							!event.ctrlKey &&
							!event.shiftKey &&
							!event.altKey
						const link =
							event.target instanceof Element
								? event.target.closest("a[data-peek-index]")
								: null
						const index = Number(link?.getAttribute("data-peek-index") ?? Number.NaN)
						// Below `md` the peek is off: the tap follows the link to the trace page.
						const isMobile = window.matchMedia(MOBILE_QUERY).matches
						if (!isPlain || isMobile || !Number.isInteger(index)) return
						event.preventDefault()
						Queue.offerUnsafe(queue, Message.ClickedPeekRow({ index }))
					}
					element.addEventListener("click", onClick)
					return onClick
				}),
				(onClick) => Effect.sync(() => element.removeEventListener("click", onClick)),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

/** One of `AutocompleteValuesProvider`'s lookups, over the list's window. */
export const FetchAdvancedLookup = Command.define("FetchTracesAdvancedLookup", {
	args: { key: Schema.String, lookup: AutocompleteLookup, window: TimeWindow },
	messages: [Message.CompletedAdvancedLookup],
	execute: ({ key, lookup, window }) =>
		autocompleteLookup(lookup, window).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedAdvancedLookup({ key, lookup, result })),
		),
})

export const ADVANCED_TEXTAREA_ID = "traces-advanced-where"

/** A picked suggestion puts the caret after it (`handleApplySuggestion`'s rAF focus). */
export const PlaceAdvancedCursor = Command.define("PlaceTracesAdvancedCursor", {
	args: { cursor: Schema.Number },
	messages: [Message.CompletedPlaceAdvancedCursor],
	execute: ({ cursor }) =>
		Effect.sync(() => {
			const textarea = document.getElementById(ADVANCED_TEXTAREA_ID)
			if (textarea instanceof HTMLTextAreaElement) {
				textarea.focus()
				textarea.setSelectionRange(cursor, cursor)
			}
			return Message.CompletedPlaceAdvancedCursor()
		}),
})

type EditorMessage =
	| typeof Message.EditedAdvanced.Type
	| typeof Message.FocusedAdvanced.Type
	| typeof Message.BlurredAdvanced.Type
	| typeof Message.MovedAdvancedCursor.Type
	| typeof Message.PressedAdvancedKey.Type
	| typeof Message.SubmittedAdvanced.Type

/**
 * The `WhereClauseEditor` textarea's events with what Foldkit's handlers do not carry: the caret,
 * and the keys the suggestions take (only while their listbox is open, read off `aria-expanded`).
 * Enter never inserts a newline; ⌘/Ctrl+Enter applies the filter.
 */
export const MountWhereEditor = Mount.defineStream("MountTracesWhereEditor", {
	messages: [
		Message.EditedAdvanced,
		Message.FocusedAdvanced,
		Message.BlurredAdvanced,
		Message.MovedAdvancedCursor,
		Message.PressedAdvancedKey,
		Message.SubmittedAdvanced,
	],
	execute: ({ element }) =>
		Stream.callback<EditorMessage>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const textarea =
						element instanceof HTMLTextAreaElement ? element : element.querySelector("textarea")
					if (textarea === null) return null
					const caret = () => textarea.selectionStart ?? textarea.value.length
					const send = (message: EditorMessage) => Queue.offerUnsafe(queue, message)
					const listeners: ReadonlyArray<readonly [string, (event: Event) => void]> = [
						[
							"input",
							() => send(Message.EditedAdvanced({ value: textarea.value, cursor: caret() })),
						],
						["focus", () => send(Message.FocusedAdvanced({ cursor: caret() }))],
						["blur", () => send(Message.BlurredAdvanced())],
						["click", () => send(Message.MovedAdvancedCursor({ cursor: caret() }))],
						["select", () => send(Message.MovedAdvancedCursor({ cursor: caret() }))],
						[
							"keyup",
							(event) => {
								const isOpen = textarea.getAttribute("aria-expanded") === "true"
								if (
									event instanceof KeyboardEvent &&
									isOpen &&
									(event.key === "ArrowDown" || event.key === "ArrowUp")
								)
									return
								send(Message.MovedAdvancedCursor({ cursor: caret() }))
							},
						],
						[
							"keydown",
							(event) => {
								if (!(event instanceof KeyboardEvent)) return
								if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
									event.preventDefault()
									send(Message.SubmittedAdvanced())
									return
								}
								const isOpen = textarea.getAttribute("aria-expanded") === "true"
								if (event.key === "Enter") {
									event.preventDefault()
									if (isOpen) send(Message.PressedAdvancedKey({ key: "Enter" }))
									return
								}
								if (!isOpen) return
								if (["ArrowDown", "ArrowUp", "Tab", "Escape"].includes(event.key)) {
									event.preventDefault()
									event.stopPropagation()
									send(Message.PressedAdvancedKey({ key: event.key }))
								}
							},
						],
					]
					listeners.forEach(([type, listener]) => textarea.addEventListener(type, listener))
					if (document.activeElement === textarea)
						send(Message.FocusedAdvanced({ cursor: caret() }))
					return { textarea, listeners }
				}),
				(state) =>
					Effect.sync(() =>
						state?.listeners.forEach(([type, listener]) =>
							state.textarea.removeEventListener(type, listener),
						),
					),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

const LISTBOX_MAX_HEIGHT = 208
const LISTBOX_GAP = 4
const LISTBOX_MIN_SPACE_BELOW = 160

type ListboxRect = Readonly<{ left: number; width: number; top: number; bottom: number }>

/**
 * `computeListboxPosition`: under the textarea, or above it when there is no room below. Both
 * `top` and `bottom` are always written, so a flip clears the side the last placement used.
 */
export const listboxPlacement = (rect: ListboxRect, viewportHeight: number) => {
	const spaceBelow = viewportHeight - rect.bottom - LISTBOX_GAP
	const spaceAbove = rect.top - LISTBOX_GAP
	const flipUp = spaceBelow < LISTBOX_MIN_SPACE_BELOW && spaceAbove > spaceBelow
	const available = flipUp ? spaceAbove : spaceBelow
	return {
		left: `${rect.left}px`,
		width: `${rect.width}px`,
		maxHeight: `${Math.max(0, Math.min(LISTBOX_MAX_HEIGHT, available - LISTBOX_GAP))}px`,
		top: flipUp ? "" : `${rect.bottom + LISTBOX_GAP}px`,
		bottom: flipUp ? `${viewportHeight - rect.top + LISTBOX_GAP}px` : "",
	}
}

const placeListbox = (listbox: HTMLElement, textarea: Element) => {
	const placement = listboxPlacement(textarea.getBoundingClientRect(), window.innerHeight)
	listbox.style.left = placement.left
	listbox.style.width = placement.width
	listbox.style.maxHeight = placement.maxHeight
	listbox.style.top = placement.top
	listbox.style.bottom = placement.bottom
}

/** The suggestion listbox, portaled to `<body>` and pinned to the textarea while it resizes or scrolls. */
export const MountSuggestions = Mount.defineStream("MountTracesWhereSuggestions", {
	messages: [Message.CompletedPlaceAdvancedCursor],
	execute: ({ element }) =>
		Stream.unwrap(
			Effect.gen(function* () {
				yield* portalToBody(element)
				yield* Effect.acquireRelease(
					Effect.sync(() => {
						const textarea = document.getElementById(ADVANCED_TEXTAREA_ID)
						const measure = () => {
							if (textarea !== null && element instanceof HTMLElement)
								placeListbox(element, textarea)
						}
						measure()
						const observer = new ResizeObserver(measure)
						if (textarea !== null) observer.observe(textarea)
						window.addEventListener("resize", measure)
						window.addEventListener("scroll", measure, true)
						return { observer, measure }
					}),
					({ observer, measure }) =>
						Effect.sync(() => {
							observer.disconnect()
							window.removeEventListener("resize", measure)
							window.removeEventListener("scroll", measure, true)
						}),
				)
				return Stream.never
			}),
		),
})
