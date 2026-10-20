import type { AiSessionSpan } from "@maple/domain/http"
import {
	type AiSpanCategory,
	classifyAiSpan,
	isLlmCall,
	type SessionTurn,
	spanEndMs,
	spanFailed,
	spanModel,
	spanStartMs,
	spanTokenBuckets,
} from "@maple/agent-sessions"
import { filterSpans, isDelegation, shortTarget } from "../../../lib/agent-sessions/span-filters"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"

// The session flow's grid layout (`layoutLanes`, `flowSpans`, `assignColumns`, `nodeSubtitle`).

export const NODE_WIDTH = 148
export const NODE_HEIGHT = 52
const COLUMN_GAP = 48
const STACK_GAP = 10
const LANE_GAP = 40
const LANE_LABEL_WIDTH = 120
export const CANVAS_PADDING = 20
const MAX_COLUMNS = 8
const WRAP_GAP = 24
export const MIN_ZOOM = 0.5
export const MAX_ZOOM = 1.5
const PAN_MARGIN = 400

export type FlowNode = Readonly<{
	key: string
	span: AiSessionSpan
	category: AiSpanCategory
	title: string
	subtitle: string
	isErrored: boolean
	count: number
	x: number
	y: number
}>

export type FlowLane = Readonly<{
	turn: SessionTurn
	nodes: ReadonlyArray<FlowNode>
	edges: ReadonlyArray<readonly [FlowNode, FlowNode]>
	height: number
}>

type FlowGroup = Readonly<{ spans: ReadonlyArray<AiSessionSpan>; parentSpanId: string | undefined }>

/** Every span above this one, nearest first; a parent cycle stops the walk. */
const ancestors = (
	span: AiSessionSpan,
	byId: ReadonlyMap<string, AiSessionSpan>,
): ReadonlyArray<AiSessionSpan> => {
	const walk = (
		parent: AiSessionSpan | undefined,
		seen: ReadonlySet<string>,
	): ReadonlyArray<AiSessionSpan> =>
		parent === undefined || seen.has(parent.spanId)
			? []
			: [parent, ...walk(byId.get(parent.parentSpanId), new Set([...seen, parent.spanId]))]
	return walk(byId.get(span.parentSpanId), new Set([span.spanId]))
}

/** The spans worth a node: the anchor, leaf work and real delegations, under their nearest drawn ancestor. */
const flowSpans = (turn: SessionTurn, query: string, agentSpansOnly: boolean): ReadonlyArray<FlowGroup> => {
	const byId = new Map(turn.spans.map((span) => [span.spanId, span]))
	const candidates = filterSpans(turn.spans, query, agentSpansOnly).filter((span) => {
		const category = classifyAiSpan(span)
		if (category === "other") return false
		if (span.spanId === turn.anchor.spanId) return true
		return category === "agent" ? isDelegation(span, byId) : true
	})
	const wrappers = new Set(
		candidates.flatMap((span) => {
			const category = classifyAiSpan(span)
			return ancestors(span, byId)
				.filter((ancestor) => classifyAiSpan(ancestor) === category)
				.map((ancestor) => ancestor.spanId)
		}),
	)
	const survivors = candidates.filter(
		(span) => classifyAiSpan(span) === "agent" || !wrappers.has(span.spanId),
	)
	const surviving = new Set(survivors.map((span) => span.spanId))
	return survivors.map((span) => ({
		spans: [span],
		parentSpanId: ancestors(span, byId).find((ancestor) => surviving.has(ancestor.spanId))?.spanId,
	}))
}

const nodeTitle = (span: AiSessionSpan): string => span.genAi.toolName ?? span.spanName
const mergeKey = (span: AiSessionSpan): string => `${classifyAiSpan(span)}:${nodeTitle(span)}`

/** Runs of identical calls under the same parent become one node. */
const mergeConsecutive = (groups: ReadonlyArray<FlowGroup>): ReadonlyArray<FlowGroup> =>
	groups.reduce<ReadonlyArray<FlowGroup>>((merged, group) => {
		const current = merged.at(-1)
		const lead = current?.spans[0]
		const first = group.spans[0]
		return current !== undefined &&
			lead !== undefined &&
			first !== undefined &&
			current.parentSpanId === group.parentSpanId &&
			mergeKey(lead) === mergeKey(first)
			? [...merged.slice(0, -1), { ...current, spans: [...current.spans, ...group.spans] }]
			: [...merged, group]
	}, [])

const groupStartMs = (group: FlowGroup): number => {
	const first = group.spans[0]
	return first === undefined ? 0 : spanStartMs(first)
}
const groupEndMs = (group: FlowGroup): number => Math.max(...group.spans.map(spanEndMs))

/**
 * Columns from the parent relation: a group follows its parent's column; overlapping siblings
 * share a column, sequential ones take successive columns. Groups arrive in start order.
 */
const assignColumns = (groups: ReadonlyArray<FlowGroup>): ReadonlyArray<ReadonlyArray<FlowGroup>> => {
	const indexById = new Map(
		groups.flatMap((group, index) => group.spans.map((member) => [member.spanId, index] as const)),
	)
	const open = new Map<number, { column: number; endMs: number }>()
	const columns: Array<Array<FlowGroup>> = []
	groups.forEach((group) => {
		const parent = group.parentSpanId === undefined ? -1 : (indexById.get(group.parentSpanId) ?? -1)
		const sibling = open.get(parent)
		const column = sibling === undefined ? undefined : columns[sibling.column]
		if (sibling !== undefined && column !== undefined && groupStartMs(group) < sibling.endMs) {
			column.push(group)
			sibling.endMs = Math.max(sibling.endMs, groupEndMs(group))
		} else {
			open.set(parent, { column: columns.length, endMs: groupEndMs(group) })
			columns.push([group])
		}
	})
	return columns
}

const nodeSubtitle = (lead: AiSessionSpan, group: ReadonlyArray<AiSessionSpan>): string => {
	const head = ((): ReadonlyArray<string> => {
		if (spanFailed(lead)) {
			const errorType = lead.genAi.errorType
			if (errorType !== undefined && errorType !== "") return [errorType]
			return [lead.statusMessage === "" ? "error" : lead.statusMessage]
		}
		if (isLlmCall(lead)) {
			const tokens = spanTokenBuckets(lead)
			if (tokens !== undefined && tokens.total > 0) {
				const completion = tokens.output + tokens.reasoning
				return [`${formatNumber(tokens.total - completion)} → ${formatNumber(completion)}`]
			}
			const model = spanModel(lead)
			return model === undefined ? [] : [shortTarget(model)]
		}
		return lead.genAi.agentName === undefined ? [] : [lead.genAi.agentName]
	})()
	const failed = group.filter((member) => spanFailed(member)).length
	return [
		...head,
		formatDuration(Math.max(...group.map(spanEndMs)) - Math.min(...group.map(spanStartMs))),
		...(group.length > 1 && failed > 0 ? [`${failed} failed`] : []),
	].join(" · ")
}

type LaneOptions = Readonly<{ mergeRepeats: boolean; query: string; agentSpansOnly: boolean }>

const layoutLane = (turn: SessionTurn, laneTop: number, options: LaneOptions): FlowLane | undefined => {
	const spans = flowSpans(turn, options.query, options.agentSpansOnly)
	if (spans.length === 0) return undefined
	const groups = options.mergeRepeats ? mergeConsecutive(spans) : spans
	const columns = assignColumns(groups)
	const rowHeights = columns.reduce<ReadonlyArray<number>>((heights, column, index) => {
		const row = Math.floor(index / MAX_COLUMNS)
		const height = column.length * (NODE_HEIGHT + STACK_GAP) - STACK_GAP
		const next = [...heights]
		next[row] = Math.max(heights[row] ?? 0, height)
		return next
	}, [])
	const rowTops = rowHeights.map(
		(_, row) => laneTop + rowHeights.slice(0, row).reduce((top, height) => top + height + WRAP_GAP, 0),
	)
	const placed = new Map<string, { node: FlowNode; column: number }>()
	const nodes = columns.flatMap((column, columnIndex) =>
		column.flatMap((group, stackIndex) => {
			const lead = group.spans.find((member) => spanFailed(member)) ?? group.spans[0]
			if (lead === undefined) return []
			const node: FlowNode = {
				key: lead.spanId,
				span: lead,
				category: classifyAiSpan(lead),
				title: nodeTitle(lead),
				subtitle: nodeSubtitle(lead, group.spans),
				isErrored: spanFailed(lead),
				count: group.spans.length,
				x:
					LANE_LABEL_WIDTH +
					CANVAS_PADDING +
					(columnIndex % MAX_COLUMNS) * (NODE_WIDTH + COLUMN_GAP),
				y:
					(rowTops[Math.floor(columnIndex / MAX_COLUMNS)] ?? laneTop) +
					stackIndex * (NODE_HEIGHT + STACK_GAP),
			}
			group.spans.forEach((member) => placed.set(member.spanId, { node, column: columnIndex }))
			return [node]
		}),
	)
	const edges = groups.flatMap((group): ReadonlyArray<readonly [FlowNode, FlowNode]> => {
		const first = group.spans[0]
		if (group.parentSpanId === undefined || first === undefined) return []
		const from = placed.get(group.parentSpanId)
		const to = placed.get(first.spanId)
		if (from === undefined || to === undefined || to.column <= from.column) return []
		if (Math.floor(from.column / MAX_COLUMNS) !== Math.floor(to.column / MAX_COLUMNS)) return []
		return [[from.node, to.node]]
	})
	const height =
		rowHeights.reduce((total, rowHeight) => total + rowHeight, 0) + (rowHeights.length - 1) * WRAP_GAP
	return { turn, nodes, edges, height }
}

/** One lane per turn with anything to draw, stacked top to bottom. */
export const layoutLanes = (
	turns: ReadonlyArray<SessionTurn>,
	options: LaneOptions,
): ReadonlyArray<FlowLane> =>
	turns.reduce<Readonly<{ lanes: ReadonlyArray<FlowLane>; top: number }>>(
		(state, turn) => {
			const lane = layoutLane(turn, state.top, options)
			return lane === undefined
				? state
				: { lanes: [...state.lanes, lane], top: state.top + lane.height + LANE_GAP }
		},
		{ lanes: [], top: CANVAS_PADDING },
	).lanes

/** Panning stays within a margin of the graph. */
export const translateExtentOf = (
	lanes: ReadonlyArray<FlowLane>,
): readonly [readonly [number, number], readonly [number, number]] => {
	const nodes = lanes.flatMap((lane) => lane.nodes)
	const maxX = Math.max(0, ...nodes.map((node) => node.x + NODE_WIDTH))
	const maxY = Math.max(0, ...nodes.map((node) => node.y + NODE_HEIGHT))
	return [
		[-PAN_MARGIN, -PAN_MARGIN],
		[maxX + PAN_MARGIN, maxY + PAN_MARGIN],
	]
}
