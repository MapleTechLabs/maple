import type { TraceData } from "@maple/web/page/traces/detail/trace-data"
import * as TraceFlow from "@maple/web/service-map/trace-flow/trace-flow"
import { Option, Result } from "effect"
import { AsyncData, Update } from "foldkit"
import { initAndSet } from "foldkit/bindingInit"
import type { Cached } from "../../data/cached"
import { accept, acceptCached, idle, keyOf, request } from "../../data/slot"
import type { LoadFailure } from "../../data/local-query"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage, replaceParams } from "../contract"
import { FetchTrace, type TraceDetailCommand } from "./command"
import {
	LogSheetBinding,
	PanelAttributesBinding,
	PanelTabsBinding,
	TabsBinding,
	TraceDetailComposition,
} from "./composition"
import { makeFieldsStep, makeNoopStep, makeStep } from "./definition"
import type { Message } from "./message"
import type { Model } from "./model"
import { PANEL_ATTRIBUTES_ID } from "./panel-model"
import { enterTabStep, selectInTabStep } from "./tabs"
import { initPanel, refetchPanel, updatePanel } from "./update-panel"
import { isTraceView, selectedSpanOf, viewOf } from "./views"

type PageResult = Readonly<{
	model: Model
	commands?: ReadonlyArray<TraceDetailCommand>
	outMessage?: PageOutMessage
}>

/** `TraceViewTabs`' default colour-by. */
const DEFAULT_COLOR_BY = "service"

const traceKey = (traceId: string) => keyOf("trace", { traceId })

export const loadedTrace = (model: Model) => Option.flatten(AsyncData.getData(model.trace.data))

/** A filter-style hash change: replace the entry with the new params. */
const setParams = (
	model: Model,
	context: PageContext,
	updates: Record<string, string | null>,
): PageResult => ({
	model,
	outMessage: replaceParams(context.location, updates),
})

/** No panel: its log sheet goes with it. */
const closePanelStep = makeFieldsStep(() => ({ panel: () => null, panelLogSheet: () => Option.none() }))

/** The span panel follows the hash's `spanId`; a new selection mounts a new panel. */
const syncPanelStep = (context: PageContext) =>
	makeStep((model: Model) => {
		const maybeTrace = loadedTrace(model)
		if (Option.isNone(maybeTrace)) return closePanelStep
		const span = selectedSpanOf(maybeTrace.value, context)
		if (span === undefined) return closePanelStep
		if (model.panel !== null && model.panel.span.spanId === span.spanId) return makeNoopStep()
		const next = initPanel(span, context.env.apiBase)
		return Update.combineSteps([
			makeStep((current: Model) => ({
				model: { ...current, panel: next.panel, panelLogSheet: Option.none() },
				commands: next.commands ?? [],
			})),
			// The panel component stays mounted across selections, so its tab does too.
			model.panel === null ? PanelTabsBinding.requestReset({ selected: "details" }) : makeNoopStep(),
			makeStep((current: Model) =>
				initAndSet(PanelAttributesBinding, current, { args: [PANEL_ATTRIBUTES_ID] }),
			),
		])
	})

/** A loaded trace mounts the hash's tab and, with a `spanId`, the span panel. */
const onLoadedStep = (context: PageContext) =>
	makeStep((model: Model) =>
		Option.match(loadedTrace(model), {
			onNone: () =>
				Update.combineSteps([
					makeFieldsStep(() => ({
						timeline: () => Option.none(),
						waterfall: () => Option.none(),
						flow: () => null,
					})),
					closePanelStep,
				]),
			onSome: (trace) =>
				Update.combineSteps([
					enterTabStep(trace, viewOf(context), selectedSpanOf(trace, context)?.spanId ?? null),
					syncPanelStep(context),
				]),
		}),
	)

/** The hash changed: a new `view` swaps the tab, a new `spanId` the selection and the panel. */
const locationChangedStep = (context: PageContext) =>
	makeStep((model: Model) =>
		Option.match(loadedTrace(model), {
			onNone: () => TabsBinding.informOfSelection({ value: viewOf(context) }),
			onSome: (trace) => {
				const view = viewOf(context)
				const spanId = selectedSpanOf(trace, context)?.spanId ?? null
				const previousSpanId = model.panel?.span.spanId ?? null
				const tabbed =
					model.tabs.selected !== view
						? enterTabStep(trace, view, spanId)
						: previousSpanId !== spanId
							? selectInTabStep(spanId)
							: makeNoopStep()
				return Update.combineSteps([tabbed, syncPanelStep(context)])
			},
		}),
	)

/** `onSelectSpan`: the span goes in the hash; re-selecting the selected span changes nothing. */
const selectSpan = (model: Model, context: PageContext, spanId: string): PageResult =>
	queryOf(context.location).get("spanId") === spanId ? { model } : setParams(model, context, { spanId })

/** `RefreshButton` without `advance`: `invalidateQueries(["local"])` refetches the trace in place. */
const refresh = (model: Model, context: PageContext): PageResult => {
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
const back = (model: Model, context: PageContext): PageResult => {
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
const settleCachedStep = (context: PageContext, key: string, cached: Cached<Option.Option<TraceData>>) =>
	makeStep((model: Model) => {
		if (model.trace.key !== key) return makeNoopStep()
		const fetch = cached.isFresh
			? []
			: [FetchTrace({ key, traceId: model.traceId, apiBase: context.env.apiBase, readsCache: false })]
		return Update.combineSteps([
			makeStep((current: Model) => ({
				model: {
					...current,
					trace: acceptCached(current.trace, key, cached, cached.isFresh),
					traceUpdatedAtMs: cached.updatedAtMs,
				},
				commands: fetch,
			})),
			onLoadedStep(context),
		])
	})

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
const settleTraceStep = (
	context: PageContext,
	key: string,
	result: Result.Result<Option.Option<TraceData>, LoadFailure>,
	fetchedAtMs: number,
) =>
	makeStep((model: Model) => {
		if (model.trace.key !== key) return makeNoopStep()
		const hadData = Option.isSome(AsyncData.getData(model.trace.data))
		const next: Model = {
			...model,
			trace: accept(model.trace, key, result, Result.isSuccess(result) ? fetchedAtMs : null),
			traceUpdatedAtMs: Result.isSuccess(result) ? fetchedAtMs : model.traceUpdatedAtMs,
			isRefreshing: false,
		}
		const changed = Result.isSuccess(result) && !sameTrace(loadedTrace(model), loadedTrace(next))
		const settled = makeFieldsStep(() => ({
			trace: () => next.trace,
			traceUpdatedAtMs: () => next.traceUpdatedAtMs,
			isRefreshing: () => false,
		}))
		return hadData && !changed ? settled : Update.combineSteps([settled, onLoadedStep(context)])
	})

/** A panel Message: the panel's own fields, then closing it or selecting another span. */
const panelStep = (model: Model, context: PageContext, message: Message): PageResult => {
	if (model.panel === null) return { model }
	const next = updatePanel(model.panel, message)
	const stepped: Model = { ...model, panel: next.panel }
	const commands = next.commands ?? []
	const outcome = next.outcome
	if (outcome === undefined || outcome._tag === "None") return { model: stepped, commands }
	const asked =
		outcome._tag === "Close"
			? setParams(stepped, context, { spanId: null })
			: selectSpan(stepped, context, outcome.spanId)
	return { ...asked, commands }
}

/** The flow canvas's own update; a node click selects its span. */
const flowStep = (model: Model, context: PageContext, child: TraceFlow.Message): PageResult => {
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
}

/** The page starts on the hash's tab; its tab strips and attributes panel start from their Bindings. */
export const init = TraceDetailComposition.makeInit((context: PageContext, traceId: string) => {
	const key = traceKey(traceId)
	return {
		childInitContext: { view: viewOf(context) },
		model: {
			_tag: "TraceDetailPage",
			traceId,
			trace: { ...idle(), key, data: AsyncData.Loading() },
			traceUpdatedAtMs: 0,
			isRefreshing: false,
			colorBy: DEFAULT_COLOR_BY,
			timeline: Option.none(),
			waterfall: Option.none(),
			flow: null,
			panel: null,
			panelLogSheet: Option.none(),
			pointer: null,
		},
		commands: [FetchTrace({ key, traceId, apiBase: context.env.apiBase, readsCache: true })],
	}
})

export const update = TraceDetailComposition.makeUpdate.withContext((context: PageContext) => ({
	FoundCachedTrace: (model, { key, cached }) => settleCachedStep(context, key, cached)(model),
	SucceededFetchTrace: (model, { key, trace, fetchedAtMs }) =>
		settleTraceStep(context, key, Result.succeed(trace), fetchedAtMs)(model),
	FailedFetchTrace: (model, { key, failure }) =>
		settleTraceStep(context, key, Result.fail(failure), 0)(model),
	ClickedBack: (model) => back(model, context),
	ClickedRefresh: (model) => refresh(model, context),
	InformedOfLocationChange: (model) => locationChangedStep(context)(model),
	// Escape closes the span panel.
	PressedEscape: (model) =>
		model.panel === null ? { model } : setParams(model, context, { spanId: null }),
	MovedPointer: (model, { x, y }) => ({ model: { ...model, pointer: { x, y } } }),
	ChoseTab: (model, { value }) =>
		isTraceView(value) && value !== model.tabs.selected
			? setParams(model, context, { view: value === "timeline" ? null : value })
			: { model },
	ChoseSpan: (model, { spanId }) => selectSpan(model, context, spanId),
	ReceivedFlowMessage: (model, { message }) => flowStep(model, context, message),
	SucceededFetchSpanDetail: (model, message) => panelStep(model, context, message),
	FailedFetchSpanDetail: (model, message) => panelStep(model, context, message),
	SucceededFetchSpanLogs: (model, message) => panelStep(model, context, message),
	FoundCachedSpanDetail: (model, message) => panelStep(model, context, message),
	FoundCachedSpanLogs: (model, message) => panelStep(model, context, message),
	FailedFetchSpanLogs: (model, message) => panelStep(model, context, message),
	ClickedClose: (model, message) => panelStep(model, context, message),
	ClickedParentSpan: (model, message) => panelStep(model, context, message),
	ClickedCopy: (model, message) => panelStep(model, context, message),
	SucceededCopy: (model, message) => panelStep(model, context, message),
	FailedCopy: (model, message) => panelStep(model, context, message),
	ElapsedCopyStatus: (model, message) => panelStep(model, context, message),
	ToggledErrorExpanded: (model, message) => panelStep(model, context, message),
	CompletedWriteClipboard: (model, message) => panelStep(model, context, message),
	// The web panel's fetches, disclosures and filters are not the local panel's.
	CompletedFetchDetail: (model) => ({ model }),
	CompletedFetchLogs: (model) => ({ model }),
	ToggledCollapsible: (model) => ({ model }),
	ClickedAttributeFilter: (model) => ({ model }),
	ClickedSpanLog: (model, { log }) =>
		model.panel === null
			? makeNoopStep()(model)
			: Option.isNone(model.panelLogSheet)
				? initAndSet(LogSheetBinding, model, { args: [log] })
				: LogSheetBinding.requestShowLog({ log })(model),
	CompletedFocusSpanPanel: (model) => ({ model }),
}))
