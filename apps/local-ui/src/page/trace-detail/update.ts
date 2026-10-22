import * as Timeline from "@maple/web/page/traces/detail/timeline"
import type { TraceData } from "@maple/web/page/traces/detail/trace-data"
import * as Waterfall from "@maple/web/page/traces/detail/waterfall"
import * as TraceFlow from "@maple/web/service-map/trace-flow/trace-flow"
import * as Tabs from "@maple/web/ui/tabs"
import { Option, Result } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import type { Cached } from "../../data/cached"
import { accept, acceptCached, idle, keyOf, request } from "../../data/slot"
import type { LoadFailure } from "../../data/local-query"
import type { Resources } from "../../platform/resources"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage, replaceParams } from "../contract"
import { FetchTrace } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { enterTab, selectedSpanOf, selectInTab, TAB_VALUES, viewOf } from "./tabs"
import { initPanel, refetchPanel, updatePanel } from "./update-panel"

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, PageOutMessage, Resources>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

/** `TraceViewTabs`' default colour-by. */
const DEFAULT_COLOR_BY = "service"

const traceKey = (traceId: string) => keyOf("trace", { traceId })

/** Runs `then` on the first step's Model, keeping both steps' Commands and the later OutMessage. */
export const chain = (first: UpdateReturn, then: (model: Model) => UpdateReturn): UpdateReturn => {
	const second = then(first.model)
	return {
		model: second.model,
		commands: [...(first.commands ?? []), ...(second.commands ?? [])],
		outMessage: second.outMessage ?? first.outMessage,
	}
}

export const loadedTrace = (model: Model) => Option.flatten(AsyncData.getData(model.trace.data))

/** A filter-style hash change: replace the entry with the new params. */
export const setParams = (
	model: Model,
	context: PageContext,
	updates: Record<string, string | null>,
): UpdateReturn => ({
	model,
	outMessage: replaceParams(context.location, updates),
})

/** The span panel follows the hash's `spanId`; a new selection mounts a new panel. */
const syncPanel = (model: Model, context: PageContext): UpdateReturn =>
	Option.match(loadedTrace(model), {
		onNone: () => ({ model: { ...model, panel: null } }),
		onSome: (trace) => {
			const span = selectedSpanOf(trace, context)
			if (span === undefined) return { model: { ...model, panel: null } }
			if (model.panel !== null && model.panel.span.spanId === span.spanId) return { model }
			const next = initPanel(span, context.env.apiBase)
			// The panel component stays mounted across selections, so its tab does too.
			const panel = model.panel === null ? next.panel : { ...next.panel, tabs: model.panel.tabs }
			return { model: { ...model, panel }, commands: next.commands }
		},
	})

/** A loaded trace mounts the hash's tab and, with a `spanId`, the span panel. */
const onLoaded = (model: Model, context: PageContext): UpdateReturn =>
	Option.match(loadedTrace(model), {
		onNone: () => ({ model: { ...model, timeline: null, waterfall: null, flow: null, panel: null } }),
		onSome: (trace) => {
			const tab = enterTab(
				model,
				trace,
				viewOf(context),
				selectedSpanOf(trace, context)?.spanId ?? null,
			)
			return chain(tab, (next) => syncPanel(next, context))
		},
	})

export const init = (
	context: PageContext,
	traceId: string,
): Readonly<{ model: Model; commands: Commands }> => {
	const key = traceKey(traceId)
	return {
		model: {
			_tag: "TraceDetailPage",
			traceId,
			trace: { ...idle(), key, data: AsyncData.Loading() },
			traceUpdatedAtMs: 0,
			isRefreshing: false,
			tabs: Tabs.init({ idBase: 23, values: TAB_VALUES, selected: viewOf(context) }),
			colorBy: DEFAULT_COLOR_BY,
			timeline: null,
			waterfall: null,
			flow: null,
			panel: null,
			pointer: null,
		},
		commands: [FetchTrace({ key, traceId, apiBase: context.env.apiBase, readsCache: true })],
	}
}

/** The hash changed: a new `view` swaps the tab, a new `spanId` the selection and the panel. */
export const locationChanged = (model: Model, context: PageContext): UpdateReturn =>
	Option.match(loadedTrace(model), {
		onNone: () => ({ model: { ...model, tabs: { ...model.tabs, selected: viewOf(context) } } }),
		onSome: (trace) => {
			const view = viewOf(context)
			const spanId = selectedSpanOf(trace, context)?.spanId ?? null
			const previousSpanId = model.panel?.span.spanId ?? null
			const tabbed =
				model.tabs.selected !== view
					? enterTab(model, trace, view, spanId)
					: previousSpanId !== spanId
						? selectInTab(model, spanId)
						: { model }
			return chain(tabbed, (next) => syncPanel(next, context))
		},
	})

/** `onSelectSpan`: the span goes in the hash; re-selecting the selected span changes nothing. */
const selectSpan = (model: Model, context: PageContext, spanId: string): UpdateReturn =>
	queryOf(context.location).get("spanId") === spanId ? { model } : setParams(model, context, { spanId })

/** `RefreshButton` without `advance`: `invalidateQueries(["local"])` refetches the trace in place. */
const refresh = (model: Model, context: PageContext): UpdateReturn => {
	if (model.isRefreshing || model.trace.key === null) return { model }
	const trace = Option.getOrElse(request(model.trace, model.trace.key, true), () => model.trace)
	const panel = model.panel === null ? null : refetchPanel(model.panel, context.env.apiBase)
	return {
		model: { ...model, trace, isRefreshing: true, panel: panel === null ? null : panel.panel },
		commands: [
			FetchTrace({
				key: model.trace.key,
				traceId: model.traceId,
				apiBase: context.env.apiBase,
				readsCache: false,
			}),
			...(panel?.commands ?? []),
		],
		outMessage: PageOutMessage.RefetchedInPlace(),
	}
}

/** `onBack`: history back, else the list with the detail-only params dropped. */
const back = (model: Model, context: PageContext): UpdateReturn => {
	const query = queryOf(context.location)
	query.delete("spanId")
	query.delete("view")
	const search = query.toString()
	return {
		model,
		outMessage: PageOutMessage.RequestedBack({ fallbackHash: `#/traces${search ? `?${search}` : ""}` }),
	}
}

/** The cache answered first: show it (a first load mounts the tab and panel), then fetch unless fresh. */
const settleCached = (
	model: Model,
	context: PageContext,
	key: string,
	cached: Cached<Option.Option<TraceData>>,
): UpdateReturn => {
	if (model.trace.key !== key) return { model }
	const next: Model = {
		...model,
		trace: acceptCached(model.trace, key, cached, cached.isFresh),
		traceUpdatedAtMs: cached.updatedAtMs,
	}
	const fetch: Commands = cached.isFresh
		? []
		: [FetchTrace({ key, traceId: model.traceId, apiBase: context.env.apiBase, readsCache: false })]
	return chain({ model: next, commands: fetch }, (loaded) => onLoaded(loaded, context))
}

/** Spans and duration identify a result; a refetch that changes them rebuilds the tab like legacy's re-render. */
const traceSignature = (trace: Option.Option<TraceData>): string =>
	Option.match(trace, {
		onNone: () => "none",
		onSome: (t) =>
			`${t.totalDurationMs}|${t.rootSpans.map((s) => s.spanId).join(",")}|${t.spans.map((s) => s.spanId).join(",")}`,
	})
const sameTrace = (a: Option.Option<TraceData>, b: Option.Option<TraceData>) =>
	traceSignature(a) === traceSignature(b)

/** The trace answered: a first load mounts the tab and panel; a refetch keeps them unless the trace changed. */
const settleTrace = (
	model: Model,
	context: PageContext,
	key: string,
	result: Result.Result<Option.Option<TraceData>, LoadFailure>,
	fetchedAtMs: number,
): UpdateReturn => {
	if (model.trace.key !== key) return { model }
	const hadData = Option.isSome(AsyncData.getData(model.trace.data))
	const next: Model = {
		...model,
		trace: accept(model.trace, key, result, Result.isSuccess(result) ? fetchedAtMs : null),
		traceUpdatedAtMs: Result.isSuccess(result) ? fetchedAtMs : model.traceUpdatedAtMs,
		isRefreshing: false,
	}
	const changed = Result.isSuccess(result) && !sameTrace(loadedTrace(model), loadedTrace(next))
	return hadData && !changed ? { model: next } : onLoaded(next, context)
}

const panelStep = (model: Model, context: PageContext, message: Message): UpdateReturn => {
	if (model.panel === null) return { model }
	const next = updatePanel(model.panel, message)
	const stepped: UpdateReturn = { model: { ...model, panel: next.panel }, commands: next.commands }
	const outcome = next.outcome
	if (outcome === undefined || outcome._tag === "None") return stepped
	if (outcome._tag === "Close") return chain(stepped, (m) => setParams(m, context, { spanId: null }))
	return chain(stepped, (m) => selectSpan(m, context, outcome.spanId))
}

export const update = (model: Model, message: Message, context: PageContext): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		FoundCachedTrace: ({ key, cached }) => settleCached(model, context, key, cached),
		SucceededFetchTrace: ({ key, trace, fetchedAtMs }) =>
			settleTrace(model, context, key, Result.succeed(trace), fetchedAtMs),
		FailedFetchTrace: ({ key, failure }) => settleTrace(model, context, key, Result.fail(failure), 0),
		ClickedBack: () => back(model, context),
		ClickedRefresh: () => refresh(model, context),
		// Escape closes the span panel.
		PressedEscape: () => (model.panel === null ? { model } : setParams(model, context, { spanId: null })),
		MovedPointer: ({ x, y }) => ({ model: { ...model, pointer: { x, y } } }),
		GotTabsMessage: ({ message: child }) => {
			const next = Tabs.update(model.tabs, child)
			const lifted: UpdateReturn = {
				model: { ...model, tabs: next.model },
				commands: Command.mapMessages(next.commands ?? [], (tab) =>
					Message.GotTabsMessage({ message: tab }),
				),
			}
			const view = TAB_VALUES.find((value) => value === next.model.selected)
			return view === undefined || view === model.tabs.selected
				? lifted
				: chain(lifted, (m) =>
						setParams({ ...m, tabs: model.tabs }, context, {
							view: view === "timeline" ? null : view,
						}),
					)
		},
		GotTimelineMessage: ({ message: child }) => {
			if (model.timeline === null) return { model }
			const next = Timeline.update(model.timeline, child)
			const lifted: UpdateReturn = {
				model: { ...model, timeline: next.model },
				commands: Command.mapMessages(next.commands ?? [], (inner) =>
					Message.GotTimelineMessage({ message: inner }),
				),
			}
			const out = next.outMessage
			if (out === undefined) return lifted
			if (out._tag === "SelectedSpan") return chain(lifted, (m) => selectSpan(m, context, out.spanId))
			return chain(lifted, (m) => {
				if (m.timeline === null) return { model: m }
				const recolored = Timeline.setColorBy(m.timeline, out.colorBy)
				return {
					model: { ...m, colorBy: out.colorBy, timeline: recolored.model },
					commands: Command.mapMessages(recolored.commands ?? [], (inner) =>
						Message.GotTimelineMessage({ message: inner }),
					),
				}
			})
		},
		GotWaterfallMessage: ({ message: child }) => {
			if (model.waterfall === null) return { model }
			const next = Waterfall.update(model.waterfall, child)
			const lifted: UpdateReturn = {
				model: { ...model, waterfall: next.model },
				commands: Command.mapMessages(next.commands ?? [], (inner) =>
					Message.GotWaterfallMessage({ message: inner }),
				),
			}
			const out = next.outMessage
			return out === undefined ? lifted : chain(lifted, (m) => selectSpan(m, context, out.spanId))
		},
		GotFlowMessage: ({ message: child }) => {
			if (model.flow === null) return { model }
			const stepped = TraceFlow.update(model.flow.graph)(model.flow.model, child)
			// Handles stay measured at the unfitted zoom (exact positions): legacy's re-measure at the
			// fitted zoom only adds sub-1e-3 px float residue, which made one edge label round differently.
			const flowModel = {
				...stepped,
				canvas: { ...stepped.canvas, measureEpoch: model.flow.model.canvas.measureEpoch },
			}
			const next: Model = { ...model, flow: { ...model.flow, model: flowModel } }
			const picked = Option.getOrUndefined(flowModel.selectedSpanId)
			return child._tag === "ClickedSpanNode" && picked !== undefined
				? selectSpan(next, context, picked)
				: { model: next }
		},
		SucceededFetchSpanDetail: () => panelStep(model, context, message),
		FailedFetchSpanDetail: () => panelStep(model, context, message),
		SucceededFetchSpanLogs: () => panelStep(model, context, message),
		FoundCachedSpanDetail: () => panelStep(model, context, message),
		FoundCachedSpanLogs: () => panelStep(model, context, message),
		FailedFetchSpanLogs: () => panelStep(model, context, message),
		GotSpanPanelMessage: () => panelStep(model, context, message),
		GotPanelTabsMessage: () => panelStep(model, context, message),
		ClickedSpanLog: () => panelStep(model, context, message),
		GotLogSheetMessage: () => panelStep(model, context, message),
		GotAttributesMessage: () => panelStep(model, context, message),
		CompletedWriteClipboard: () => panelStep(model, context, message),
		ElapsedCopyStatus: () => panelStep(model, context, message),
		CompletedFocusSpanPanel: () => ({ model }),
	})
