import { PROFILE_SPAN_IDS_MAX } from "@maple/domain/http"
import { Option, Record, Array as Arr } from "effect"
import { AsyncData, Command } from "foldkit"
import * as ProfileFlamegraph from "../../profiles/profile-flamegraph"
import * as Tabs from "../../ui/tabs"
import type { SpanNodeData } from "../trace-data"
import type { TraceSource } from "../trace-source"
import {
	FetchSpanDetail,
	FetchSpanLogs,
	FetchSpanProfile,
	LOG_LIMIT,
	WaitSpanCopyStatus,
	WriteSpanClipboard,
} from "./command"
import { Message, OutMessage } from "./message"
import { acceptRead, type CopyStatus, idleRead, type Model, type PanelState, type Read } from "./model"

export type InitInput = Readonly<{
	span: SpanNodeData
	traceStartTime: string
	totalDurationMs: number
}>

type Commands = ReadonlyArray<Command.Command<Message, never, TraceSource>>

export type Return = Readonly<{ model: Model; commands?: Commands; outMessage?: OutMessage }>

type StateReturn<S> = Readonly<{ model: S; commands?: Commands; outMessage?: OutMessage }>

export const TAB_VALUES = ["details", "logs", "infrastructure", "profile"] as const

/**
 * The tabs model over the tabs on screen. Its indexes count against `shown` alone: the highlight
 * follows its tab by value, and one left by a longer earlier set falls back to the selected tab.
 */
export const tabsOver = (tabs: Tabs.Model, shown: ReadonlyArray<string>): Tabs.Model => {
	const selected = shown.includes(tabs.selected) ? tabs.selected : (shown[0] ?? tabs.selected)
	const highlighted = tabs.values[tabs.highlightedIndex]
	const kept = highlighted === undefined ? -1 : shown.indexOf(highlighted)
	return {
		...tabs,
		values: shown,
		selected,
		highlightedIndex: kept >= 0 ? kept : Math.max(0, shown.indexOf(selected)),
	}
}

/** Span ids one profile read names, the API's limit: a deeper subtree is cut off, widest levels first. */
export const PROFILE_SPAN_CAP = PROFILE_SPAN_IDS_MAX

/** The span and its descendants, breadth first: a sample belongs to the innermost running span. */
export const subtreeSpanIds = (span: SpanNodeData): ReadonlyArray<string> => {
	const ids: Array<string> = []
	let level: ReadonlyArray<SpanNodeData> = [span]
	while (level.length > 0 && ids.length < PROFILE_SPAN_CAP) {
		ids.push(...Arr.map(level, (node) => node.spanId))
		level = Arr.flatMap(level, (node) => node.children)
	}
	return ids.slice(0, PROFILE_SPAN_CAP)
}

/** Whether more spans sit under `span` than one read names, so its profile covers only some. */
export const subtreeIsCut = (span: SpanNodeData): boolean => {
	let count = 0
	let level: ReadonlyArray<SpanNodeData> = [span]
	while (level.length > 0) {
		count += level.length
		if (count > PROFILE_SPAN_CAP) return true
		level = Arr.flatMap(level, (node) => node.children)
	}
	return false
}

/** A read's key: the span it is for (the panel is mounted per span). */
export const detailKeyOf = (span: SpanNodeData): string => `span-detail:${span.traceId}:${span.spanId}`
export const logsKeyOf = (span: SpanNodeData): string => `span-logs:${span.traceId}:${span.spanId}`
export const profileKeyOf = (span: SpanNodeData): string => `span-profile:${span.traceId}:${span.spanId}`

/** The panel's reads: the logs always, the full attributes unless the span is missing from the trace. */
const fetches = (span: SpanNodeData, readsCache: boolean): Commands => [
	FetchSpanLogs({
		key: logsKeyOf(span),
		request: {
			traceId: span.traceId,
			spanId: span.spanId,
			startTime: span.startTime,
			durationMs: span.durationMs,
			limit: LOG_LIMIT,
		},
		readsCache,
	}),
	...(span.isMissing === true
		? []
		: [
				FetchSpanProfile({
					key: profileKeyOf(span),
					request: {
						traceId: span.traceId,
						spanIds: subtreeSpanIds(span),
						startTime: span.startTime,
						durationMs: span.durationMs,
					},
				}),
				FetchSpanDetail({
					key: detailKeyOf(span),
					request: { traceId: span.traceId, spanId: span.spanId, timestamp: span.startTime },
					fallback: {
						spanAttributes: span.spanAttributes,
						resourceAttributes: span.resourceAttributes,
					},
					readsCache,
				}),
			]),
]

/** The panel as it mounts, with its reads in flight. */
export const init = (input: InitInput): Return => {
	const { span } = input
	return {
		model: {
			span,
			traceStartTime: input.traceStartTime,
			totalDurationMs: input.totalDurationMs,
			detail:
				span.isMissing === true ? idleRead() : { key: detailKeyOf(span), data: AsyncData.Loading() },
			logs: { key: logsKeyOf(span), data: AsyncData.Loading() },
			profile:
				span.isMissing === true ? idleRead() : { key: profileKeyOf(span), data: AsyncData.Loading() },
			flamegraph: ProfileFlamegraph.init(`span-profile-${span.spanId}`),
			tabs: Tabs.init({ idBase: 32, values: TAB_VALUES, selected: "details" }),
			copies: {},
			openIds: [],
			isErrorExpanded: false,
		},
		commands: fetches(span, true),
	}
}

const revalidate = <A>(read: Read<A>): Read<A> =>
	read.key === null
		? read
		: { ...read, data: Option.getOrElse(AsyncData.revalidateOrLoad(read.data), () => read.data) }

/** The reader refreshed: ask the source again past any cache, the current data staying up. */
export const refresh = (model: Model): Return => ({
	model: {
		...model,
		detail: revalidate(model.detail),
		logs: revalidate(model.logs),
		profile: revalidate(model.profile),
	},
	commands: fetches(model.span, false),
})

/** A cached answer for the read's key: shown at once, revalidating unless fresh. */
const fromCache = <A>(read: Read<A>, key: string, data: A, isFresh: boolean): Read<A> =>
	read.key !== key
		? read
		: { key, data: isFresh ? AsyncData.Success({ data }) : AsyncData.Refreshing({ data }) }

const copyStatus = <S extends PanelState>(
	model: S,
	id: string,
	generation: number,
	status: CopyStatus,
): StateReturn<S> =>
	model.copies[id]?.generation === generation
		? {
				model: { ...model, copies: Record.set(model.copies, id, { status, generation }) },
				commands: [WaitSpanCopyStatus({ id, generation })],
			}
		: { model }

const toggled = (ids: ReadonlyArray<string>, id: string): ReadonlyArray<string> =>
	ids.includes(id) ? Arr.filter(ids, (open) => open !== id) : [...ids, id]

/** The panel's reads, copies and disclosures over any model holding them (the session popover's too). */
export const updateState = <S extends PanelState>(model: S, message: Message): StateReturn<S> =>
	Message.match<StateReturn<S>>(message, {
		CompletedFetchDetail: ({ key, result }) => ({
			model: { ...model, detail: acceptRead(model.detail, key, result) },
		}),
		CompletedFetchLogs: ({ key, result }) => ({
			model: { ...model, logs: acceptRead(model.logs, key, result) },
		}),
		FoundCachedDetail: ({ fetch, detail, isFresh }) => ({
			model: { ...model, detail: fromCache(model.detail, fetch.key, detail, isFresh) },
			commands:
				isFresh || model.detail.key !== fetch.key
					? []
					: [FetchSpanDetail({ ...fetch, readsCache: false })],
		}),
		FoundCachedLogs: ({ fetch, logs, isFresh }) => ({
			model: { ...model, logs: fromCache(model.logs, fetch.key, logs, isFresh) },
			commands:
				isFresh || model.logs.key !== fetch.key
					? []
					: [FetchSpanLogs({ ...fetch, readsCache: false })],
		}),
		ClickedClose: () => ({ model, outMessage: OutMessage.Closed() }),
		ClickedParentSpan: ({ spanId }) => ({ model, outMessage: OutMessage.SelectedSpanId({ spanId }) }),
		ClickedLog: ({ key }) => ({ model, outMessage: OutMessage.SelectedLog({ key }) }),
		ClickedCopy: ({ id, text }) => {
			const generation = (model.copies[id]?.generation ?? 0) + 1
			const status = model.copies[id]?.status ?? "idle"
			const next = { ...model, copies: Record.set(model.copies, id, { status, generation }) }
			return text === ""
				? copyStatus(next, id, generation, "error")
				: { model: next, commands: [WriteSpanClipboard({ id, text, generation })] }
		},
		SucceededCopy: ({ id, generation }) => copyStatus(model, id, generation, "copied"),
		FailedCopy: ({ id, generation }) => copyStatus(model, id, generation, "error"),
		ElapsedCopyStatus: ({ id, generation }) =>
			model.copies[id]?.generation === generation
				? {
						model: {
							...model,
							copies: Record.set(model.copies, id, { status: "idle", generation }),
						},
					}
				: { model },
		ToggledCollapsible: ({ id }) => ({ model: { ...model, openIds: toggled(model.openIds, id) } }),
		ToggledErrorExpanded: () => ({ model: { ...model, isErrorExpanded: !model.isErrorExpanded } }),
		ClickedAttributeFilter: (filter) => ({
			model,
			outMessage: OutMessage.RequestedAttributeFilter({
				scope: filter.scope,
				key: filter.key,
				value: filter.value,
				isExclude: filter.isExclude,
			}),
		}),
		// The panel's own tab strip and profile; a holder without them keeps its state.
		GotTabsMessage: () => ({ model }),
		CompletedFetchProfile: () => ({ model }),
		GotFlamegraphMessage: () => ({ model }),
	})

export const update = (model: Model, message: Message): Return => {
	if (message._tag === "CompletedFetchProfile")
		return { model: { ...model, profile: acceptRead(model.profile, message.key, message.result) } }
	if (message._tag === "GotFlamegraphMessage")
		return {
			model: {
				...model,
				flamegraph: ProfileFlamegraph.update(model.flamegraph, message.message).model,
			},
		}
	if (message._tag !== "GotTabsMessage") return updateState(model, message)
	// The strip only draws the shown tabs, so the tabs update runs over those.
	const { shown } = message
	const next = Tabs.update(tabsOver(model.tabs, shown), message.message)
	return {
		model: { ...model, tabs: next.model },
		commands: Command.mapMessages(next.commands ?? [], (tab) =>
			Message.GotTabsMessage({ message: tab, shown }),
		),
	}
}
