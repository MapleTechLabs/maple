import { spanStartMs } from "@maple/ui/lib/span-tree"
import type { SpanNodeData } from "./trace-data"

// copied: `computeServiceShares` (packages/ui/src/components/traces/service-spectrum-bar.tsx, a
// React module). Wall-clock time per service: each instant goes to the innermost spans running.

export interface ServiceShare {
	readonly serviceName: string
	readonly durationMs: number
	readonly percent: number
}

type Interval = readonly [number, number]

/** The parts of `[start, end]` no child covers: the span's self time. */
const selfIntervals = (
	start: number,
	end: number,
	children: ReadonlyArray<SpanNodeData>,
): Array<Interval> => {
	const covered = children
		.map((child): Interval => {
			const childStart = spanStartMs(child)
			return [Math.max(childStart, start), Math.min(childStart + child.durationMs, end)]
		})
		.filter(([s, e]) => e > s)
		.toSorted((a, b) => a[0] - b[0])
	const { gaps, cursor } = covered.reduce<{ gaps: Array<Interval>; cursor: number }>(
		(acc, [s, e]) => ({
			gaps: s > acc.cursor ? [...acc.gaps, [acc.cursor, s]] : acc.gaps,
			cursor: Math.max(acc.cursor, e),
		}),
		{ gaps: [], cursor: start },
	)
	return end > cursor ? [...gaps, [cursor, end]] : gaps
}

interface ShareEvent {
	readonly at: number
	readonly service: string
	readonly delta: 1 | -1
}

const eventsOf = (span: SpanNodeData, services: Set<string>): ReadonlyArray<ShareEvent> => {
	const own: ReadonlyArray<ShareEvent> = (() => {
		if (span.isMissing === true) return []
		const start = spanStartMs(span)
		if (Number.isNaN(start)) return []
		services.add(span.serviceName)
		return selfIntervals(start, start + Math.max(span.durationMs, 0), span.children).flatMap(
			([s, e]): ReadonlyArray<ShareEvent> => [
				{ at: s, service: span.serviceName, delta: 1 },
				{ at: e, service: span.serviceName, delta: -1 },
			],
		)
	})()
	// Stops at a span with an unparseable start, children included.
	if (span.isMissing !== true && Number.isNaN(spanStartMs(span))) return own
	return [...own, ...span.children.flatMap((child) => eventsOf(child, services))]
}

export const computeServiceShares = (rootSpans: ReadonlyArray<SpanNodeData>): ReadonlyArray<ServiceShare> => {
	const services = new Set<string>()
	const events = rootSpans
		.flatMap((root) => eventsOf(root, services))
		.toSorted((a, b) => a.at - b.at || a.delta - b.delta)
	const state = {
		active: new Map<string, number>(),
		attributed: new Map<string, number>(),
		activeTotal: 0,
		prev: events[0]?.at ?? 0,
	}
	events.forEach((event) => {
		const dt = event.at - state.prev
		if (dt > 0 && state.activeTotal > 0) {
			state.active.forEach((count, service) => {
				state.attributed.set(
					service,
					(state.attributed.get(service) ?? 0) + (dt * count) / state.activeTotal,
				)
			})
		}
		state.prev = event.at
		const next = (state.active.get(event.service) ?? 0) + event.delta
		if (next === 0) state.active.delete(event.service)
		else state.active.set(event.service, next)
		state.activeTotal += event.delta
	})
	const total = [...state.attributed.values()].reduce((sum, ms) => sum + ms, 0)
	return [...services]
		.map((serviceName) => {
			const durationMs = state.attributed.get(serviceName) ?? 0
			return {
				serviceName,
				durationMs,
				percent: total > 0 ? (durationMs / total) * 100 : 100 / services.size,
			}
		})
		.toSorted((a, b) => b.durationMs - a.durationMs)
}
