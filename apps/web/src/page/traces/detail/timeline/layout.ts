import { clampViewport, viewportBounds } from "@maple/ui/components/traces/clamp-viewport"
import {
	isStatusCodePreset,
	resolveColorValue,
	type ColorByField,
} from "@maple/ui/components/traces/color-by"
import {
	DEFAULT_MAX_WINDOW_MS,
	MIN_TICK_PX,
	OVERSCAN,
	ROW_GAP,
	ROW_HEIGHT,
	type ViewportState,
} from "@maple/ui/components/traces/trace-timeline-types"
import { getValueHue } from "@maple/ui/lib/colors"
import { spanStartMs } from "@maple/ui/lib/span-tree"
import type { SpanNodeData } from "../trace-data"

// copied: the pure layout half of packages/ui/src/components/traces/use-trace-timeline.ts (a React
// module), over the Model's readonly tree.

export const ROW_PITCH = ROW_HEIGHT + ROW_GAP

const ERROR_HUE = 25
const NEUTRAL_FILL = "oklch(0.22 0.005 0)"
const NEUTRAL_BORDER = "oklch(0.45 0.02 0)"

const barFillFromHue = (hue: number | null, isError: boolean, statusPreset: boolean): string => {
	if (isError && !statusPreset) return `oklch(0.22 0.06 ${ERROR_HUE})`
	if (hue === null) return NEUTRAL_FILL
	return `oklch(0.22 0.015 ${hue})`
}

const barBorderFromHue = (hue: number | null, isError: boolean, statusPreset: boolean): string => {
	if (isError && !statusPreset) return `oklch(0.62 0.22 ${ERROR_HUE})`
	if (hue === null) return NEUTRAL_BORDER
	return `oklch(0.55 0.18 ${hue})`
}

/** `TimelineBar` over `SpanNodeData`. */
export interface Bar {
	readonly span: SpanNodeData
	readonly startMs: number
	readonly endMs: number
	readonly offsetStartMs: number
	readonly offsetEndMs: number
	readonly depth: number
	readonly isError: boolean
	readonly isCollapsed: boolean
	readonly childCount: number
	readonly fill: string
	readonly borderColor: string
	readonly hasChildren: boolean
}

/** `countDescendants`. */
export const countDescendants = (node: SpanNodeData): number =>
	node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0)

/** `layoutSpans`: the visible rows, depth-first, collapsed subtrees skipped. */
export const layoutSpans = (
	rootSpans: ReadonlyArray<SpanNodeData>,
	expanded: ReadonlySet<string>,
	colorBy: ColorByField,
	traceStartMs: number,
): ReadonlyArray<Bar> => {
	const statusPreset = isStatusCodePreset(colorBy)
	const visit = (node: SpanNodeData): ReadonlyArray<Bar> => {
		const startMs = spanStartMs(node)
		const endMs = startMs + node.durationMs
		const hasChildren = node.children.length > 0
		const isCollapsed = hasChildren && !expanded.has(node.spanId)
		const isError = node.statusCode === "Error"
		const hue = getValueHue(resolveColorValue(node, colorBy))
		const bar: Bar = {
			span: node,
			startMs,
			endMs,
			offsetStartMs: startMs - traceStartMs,
			offsetEndMs: endMs - traceStartMs,
			depth: node.depth,
			isError,
			isCollapsed,
			childCount: isCollapsed ? countDescendants(node) : 0,
			fill: barFillFromHue(hue, isError, statusPreset),
			borderColor: barBorderFromHue(hue, isError, statusPreset),
			hasChildren,
		}
		return isCollapsed ? [bar] : [bar, ...node.children.flatMap(visit)]
	}
	return rootSpans.flatMap(visit)
}

/** Every span id with children, bucketed by depth (`collectParentIdsByLevel`). */
export const collectParentIdsByLevel = (rootSpans: ReadonlyArray<SpanNodeData>): Map<number, Set<string>> => {
	const byLevel = new Map<number, Set<string>>()
	const visit = (node: SpanNodeData): void => {
		if (node.children.length === 0) return
		const level = byLevel.get(node.depth) ?? new Set<string>()
		level.add(node.spanId)
		byLevel.set(node.depth, level)
		node.children.forEach(visit)
	}
	rootSpans.forEach(visit)
	return byLevel
}

const allSpans = (rootSpans: ReadonlyArray<SpanNodeData>): ReadonlyArray<SpanNodeData> =>
	rootSpans.flatMap((node) => [node, ...allSpans(node.children)])

export const countSpans = (rootSpans: ReadonlyArray<SpanNodeData>): number => allSpans(rootSpans).length

/** The trace bounds over every span, reported window as the fallback; never zero-width. */
export const traceBounds = (
	rootSpans: ReadonlyArray<SpanNodeData>,
	traceStartTime: string,
	totalDurationMs: number,
): { traceStartMs: number; traceEndMs: number } => {
	const reportedStart = new Date(traceStartTime).getTime()
	const finite = allSpans(rootSpans)
		.map((node) => ({ start: spanStartMs(node), duration: node.durationMs }))
		.filter(({ start }) => Number.isFinite(start))
	const start = finite.length === 0 ? reportedStart : Math.min(reportedStart, ...finite.map((s) => s.start))
	const end =
		finite.length === 0
			? reportedStart + totalDurationMs
			: Math.max(reportedStart + totalDurationMs, ...finite.map((s) => s.start + s.duration))
	return { traceStartMs: start, traceEndMs: end <= start ? start + 1 : end }
}

/** `defaultViewport`: the padded trace, or its first 10 s for long traces. */
export const defaultViewport = (traceStartMs: number, traceEndMs: number): ViewportState => {
	const bounds = viewportBounds(traceStartMs, traceEndMs)
	if (traceEndMs - traceStartMs <= DEFAULT_MAX_WINDOW_MS)
		return clampViewport({ startMs: bounds.loMs, endMs: bounds.hiMs }, traceStartMs, traceEndMs)
	const pad = DEFAULT_MAX_WINDOW_MS * 0.02
	return clampViewport(
		{ startMs: traceStartMs - pad, endMs: traceStartMs + DEFAULT_MAX_WINDOW_MS + pad },
		traceStartMs,
		traceEndMs,
	)
}

const NICE_INTERVALS = [
	0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000,
	5000, 10000, 20000, 60000,
]

const niceIntervalAtLeast = (raw: number): number =>
	NICE_INTERVALS.find((nice) => nice >= raw) ?? Math.max(60_000, Math.ceil(raw / 60_000) * 60_000)

/** `computeTimeAxisTicks`: offsets from the trace start, budgeted against the column width. */
export const computeTimeAxisTicks = (
	viewport: ViewportState,
	traceStartMs: number,
	columnWidthPx: number,
): { ticks: ReadonlyArray<number>; intervalMs: number } => {
	const visible = viewport.endMs - viewport.startMs
	if (!(visible > 0) || !(columnWidthPx > 0)) return { ticks: [], intervalMs: 1 }
	const maxTicks = Math.max(1, Math.floor(columnWidthPx / MIN_TICK_PX))
	const intervalMs = niceIntervalAtLeast(visible / maxTicks)
	const from = viewport.startMs - traceStartMs
	const to = viewport.endMs - traceStartMs
	const first = Math.ceil(from / intervalMs) * intervalMs
	// Accumulates (`t += intervalMs`) rather than multiplying, so float drift stays stable.
	const ticks = Array.from({ length: 512 }).reduce<{ list: Array<number>; t: number; done: boolean }>(
		(acc) => {
			if (acc.done || acc.t > to) return { ...acc, done: true }
			acc.list.push(acc.t)
			return { ...acc, t: acc.t + intervalMs }
		},
		{ list: [], t: first, done: false },
	).list
	return { ticks, intervalMs }
}

export const computeSearchMatches = (bars: ReadonlyArray<Bar>, query: string): ReadonlySet<string> => {
	if (query.trim() === "") return new Set()
	const q = query.toLowerCase()
	return new Set(
		bars
			.filter(
				(bar) =>
					bar.span.spanName.toLowerCase().includes(q) ||
					bar.span.serviceName.toLowerCase().includes(q) ||
					bar.span.spanId.toLowerCase().includes(q),
			)
			.map((bar) => bar.span.spanId),
	)
}

/** `Virtualizer.getVirtualItems()` for fixed `ROW_PITCH` rows (virtual-core's range + overscan). */
export const virtualRange = (count: number, scrollTop: number, height: number): ReadonlyArray<number> => {
	if (count === 0 || height === 0) return []
	const last = count - 1
	const startIndex = count <= 1 ? 0 : Math.min(last, Math.max(0, Math.floor(scrollTop / ROW_PITCH)))
	const limit = scrollTop + height
	const endIndex =
		count <= 1 ? last : Math.min(last, Math.max(startIndex, Math.ceil(limit / ROW_PITCH) - 1))
	const from = Math.max(startIndex - OVERSCAN, 0)
	const to = Math.min(endIndex + OVERSCAN, last)
	return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

// copied: `collectMinimapSpans` (packages/ui trace-timeline-minimap.tsx).

export interface MinimapSpan {
	readonly spanId: string
	readonly depth: number
	readonly leftPercent: number
	readonly widthPercent: number
	readonly bgColor: string
	readonly isError: boolean
}

const NEUTRAL_MINIMAP_BG = "oklch(0.50 0.02 0)"
const ERROR_MINIMAP_BG = "oklch(0.62 0.22 25)"

export const collectMinimapSpans = (
	rootSpans: ReadonlyArray<SpanNodeData>,
	domainStartMs: number,
	domainDurationMs: number,
	colorBy: ColorByField,
): { spans: ReadonlyArray<MinimapSpan>; maxDepth: number } => {
	const statusPreset = isStatusCodePreset(colorBy)
	const nodes = allSpans(rootSpans)
	const spans = nodes.map((node): MinimapSpan => {
		const leftPercent = ((spanStartMs(node) - domainStartMs) / domainDurationMs) * 100
		const widthPercent = (node.durationMs / domainDurationMs) * 100
		const isError = node.statusCode === "Error"
		const hue = getValueHue(resolveColorValue(node, colorBy))
		const bgColor =
			isError && !statusPreset
				? ERROR_MINIMAP_BG
				: hue === null
					? NEUTRAL_MINIMAP_BG
					: `oklch(0.50 0.14 ${hue})`
		const clampedLeft = Math.max(0, leftPercent)
		return {
			spanId: node.spanId,
			depth: node.depth,
			leftPercent: clampedLeft,
			widthPercent: Math.min(widthPercent, 100 - clampedLeft),
			bgColor,
			isError,
		}
	})
	// Errors last, painted on top of same-position siblings (a stable sort).
	return {
		spans: [...spans].sort((a, b) => Number(a.isError) - Number(b.isError)),
		maxDepth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
	}
}
