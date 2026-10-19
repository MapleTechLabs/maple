import {
	collectAllCollapsibleIds,
	collectAncestorIds,
	computeCollapseOneLevel,
	computeDefaultExpandedSpanIds,
	computeExpandOneLevel,
} from "@maple/ui/components/traces/auto-collapse"
import type { Command } from "foldkit"
import { type TraceData, toSpanNode } from "../trace-data"
import { Message, type Model, OutMessage } from "./model"
import { collectParentIdsByLevel, countSpans } from "./tree"

export type UpdateReturn = Readonly<{
	model: Model
	commands?: ReadonlyArray<Command.Command<Message>>
	outMessage?: OutMessage
}>

export type InitInput = Readonly<{ trace: TraceData; traceStartTime: string; selectedSpanId: string | null }>

const nodesOf = (model: Pick<Model, "rootSpans">) => model.rootSpans.map(toSpanNode)

/** `useState(() => computeDefaultExpandedSpanIds(rootSpans, { keepVisibleSpanId }))`. */
export const init = (input: InitInput): UpdateReturn => {
	const rootSpans = input.trace.rootSpans
	const expanded = computeDefaultExpandedSpanIds(rootSpans.map(toSpanNode), {
		keepVisibleSpanId: input.selectedSpanId ?? undefined,
	})
	return {
		model: {
			rootSpans,
			totalDurationMs: input.trace.totalDurationMs,
			traceStartTime: input.traceStartTime,
			totalSpanCount: countSpans(rootSpans),
			expanded: [...expanded],
			selectedSpanId: input.selectedSpanId,
			virtualRows: [],
			totalSize: 0,
		},
	}
}

/** The selection changed after mount: union its ancestors into the expanded set (the user's toggles survive). */
export const setSelectedSpanId = (model: Model, spanId: string | null): UpdateReturn => {
	if (spanId === model.selectedSpanId) return { model }
	if (spanId === null) return { model: { ...model, selectedSpanId: null } }
	const current = new Set(model.expanded)
	const missing = [...collectAncestorIds(nodesOf(model), spanId)].filter((id) => !current.has(id))
	return {
		model: {
			...model,
			selectedSpanId: spanId,
			expanded: missing.length === 0 ? model.expanded : [...model.expanded, ...missing],
		},
	}
}

const withExpanded = (model: Model, next: ReadonlySet<string>): UpdateReturn => ({
	model: { ...model, expanded: [...next] },
})

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ClickedToggle: ({ spanId }) => {
			const next = new Set(model.expanded)
			if (next.has(spanId)) next.delete(spanId)
			else next.add(spanId)
			return withExpanded(model, next)
		},
		ClickedRow: ({ spanId }) => ({ model, outMessage: OutMessage.SelectedSpan({ spanId }) }),
		ClickedExpandOneLevel: () =>
			withExpanded(
				model,
				computeExpandOneLevel(new Set(model.expanded), collectParentIdsByLevel(model.rootSpans)),
			),
		ClickedCollapseOneLevel: () =>
			withExpanded(
				model,
				computeCollapseOneLevel(new Set(model.expanded), collectParentIdsByLevel(model.rootSpans)),
			),
		ClickedCollapseAll: () => withExpanded(model, new Set()),
		ClickedExpandAll: () => withExpanded(model, collectAllCollapsibleIds(nodesOf(model))),
		ChangedVirtualWindow: ({ rows, totalSize }) => ({
			model: { ...model, virtualRows: rows, totalSize },
		}),
	})
