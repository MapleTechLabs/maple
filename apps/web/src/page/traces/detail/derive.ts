import { spanStartMs } from "@maple/ui/lib/span-tree"
import type { SpanNodeData } from "@maple/views/traces/trace-data"
import { Array as Arr, Order } from "effect"

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
	const covered = Arr.sort(
		Arr.filter(
			Arr.map(children, (child): Interval => {
				const childStart = spanStartMs(child)
				return [Math.max(childStart, start), Math.min(childStart + child.durationMs, end)]
			}),
			([s, e]) => e > s,
		),
		Order.mapInput(Order.Number, (interval: Interval) => interval[0]),
	)
	const { gaps, cursor } = Arr.reduce<Interval, { gaps: Array<Interval>; cursor: number }>(
		covered,
		{ gaps: [], cursor: start },
		(acc, [s, e]) => ({
			gaps: s > acc.cursor ? [...acc.gaps, [acc.cursor, s]] : acc.gaps,
			cursor: Math.max(acc.cursor, e),
		}),
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
		return Arr.flatMap(
			selfIntervals(start, start + Math.max(span.durationMs, 0), span.children),
			([s, e]): ReadonlyArray<ShareEvent> => [
				{ at: s, service: span.serviceName, delta: 1 },
				{ at: e, service: span.serviceName, delta: -1 },
			],
		)
	})()
	// Stops at a span with an unparseable start, children included.
	if (span.isMissing !== true && Number.isNaN(spanStartMs(span))) return own
	return [...own, ...Arr.flatMap(span.children, (child) => eventsOf(child, services))]
}

export const computeServiceShares = (rootSpans: ReadonlyArray<SpanNodeData>): ReadonlyArray<ServiceShare> => {
	const services = new Set<string>()
	const events = Arr.sort(
		Arr.flatMap(rootSpans, (root) => eventsOf(root, services)),
		Order.combine(
			Order.mapInput(Order.Number, (event: ShareEvent) => event.at),
			Order.mapInput(Order.Number, (event: ShareEvent) => event.delta),
		),
	)
	const state = {
		active: new Map<string, number>(),
		attributed: new Map<string, number>(),
		activeTotal: 0,
		prev: events[0]?.at ?? 0,
	}
	Arr.forEach(events, (event) => {
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
	const total = Arr.reduce([...state.attributed.values()], 0, (sum, ms) => sum + ms)
	return Arr.sort(
		Arr.map([...services], (serviceName) => {
			const durationMs = state.attributed.get(serviceName) ?? 0
			return {
				serviceName,
				durationMs,
				percent: total > 0 ? (durationMs / total) * 100 : 100 / services.size,
			}
		}),
		Order.flip(Order.mapInput(Order.Number, (share: ServiceShare) => share.durationMs)),
	)
}
