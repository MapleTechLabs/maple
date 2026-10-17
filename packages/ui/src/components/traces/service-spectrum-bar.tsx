import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip"
import { cn } from "../../lib/utils"
import { formatDuration, formatPercent } from "../../lib/format"
import { getServiceColor } from "../../lib/colors"
import { spanStartMs } from "../../lib/span-tree"

/** The minimal span-tree shape the share computation needs; `SpanNode` from
 * either the web app or this package satisfies it. */
export interface SpectrumSpan {
	serviceName: string
	startTime: string
	durationMs: number
	clockSkewMs?: number
	isMissing?: boolean
	children: ReadonlyArray<SpectrumSpan>
}

export interface ServiceShare {
	serviceName: string
	durationMs: number
	percent: number
}

type Interval = [number, number]

/** The parts of `[start, end]` not covered by any child: the span's self time. */
function selfIntervals(start: number, end: number, children: ReadonlyArray<SpectrumSpan>): Array<Interval> {
	const covered = children
		.map((child): Interval => {
			const childStart = spanStartMs(child)
			return [Math.max(childStart, start), Math.min(childStart + child.durationMs, end)]
		})
		.filter(([s, e]) => e > s)
		.sort((a, b) => a[0] - b[0])

	const gaps: Array<Interval> = []
	let cursor = start
	for (const [s, e] of covered) {
		if (s > cursor) gaps.push([cursor, s])
		cursor = Math.max(cursor, e)
	}
	if (end > cursor) gaps.push([cursor, end])
	return gaps
}

/**
 * Wall-clock time attributable to each service: every instant goes to the
 * innermost spans running then (split evenly between parallel ones), so a
 * parent that only waits on a child in another service is not credited with
 * the child's time. Shares sum to 100%. Sorted by share, descending.
 */
export function computeServiceShares(rootSpans: ReadonlyArray<SpectrumSpan>): Array<ServiceShare> {
	// Sweep events over every span's self intervals: +1/-1 at each edge, per service.
	const events: Array<{ at: number; service: string; delta: 1 | -1 }> = []
	const services = new Set<string>()
	const visit = (span: SpectrumSpan) => {
		if (!span.isMissing) {
			const start = spanStartMs(span)
			// Skip the whole subtree: the parent already counts this span's time as its own.
			if (Number.isNaN(start)) return
			services.add(span.serviceName)
			for (const [s, e] of selfIntervals(start, start + Math.max(span.durationMs, 0), span.children)) {
				events.push({ at: s, service: span.serviceName, delta: 1 })
				events.push({ at: e, service: span.serviceName, delta: -1 })
			}
		}
		for (const child of span.children) visit(child)
	}
	for (const root of rootSpans) visit(root)

	events.sort((a, b) => a.at - b.at || a.delta - b.delta)
	const active = new Map<string, number>()
	const attributed = new Map<string, number>()
	let activeTotal = 0
	let prev = events[0]?.at ?? 0
	for (const event of events) {
		const dt = event.at - prev
		if (dt > 0 && activeTotal > 0) {
			for (const [service, count] of active) {
				attributed.set(service, (attributed.get(service) ?? 0) + (dt * count) / activeTotal)
			}
		}
		prev = event.at
		const next = (active.get(event.service) ?? 0) + event.delta
		if (next === 0) active.delete(event.service)
		else active.set(event.service, next)
		activeTotal += event.delta
	}

	const total = [...attributed.values()].reduce((sum, ms) => sum + ms, 0)
	return [...services]
		.map((serviceName) => {
			const durationMs = attributed.get(serviceName) ?? 0
			return {
				serviceName,
				durationMs,
				percent: total > 0 ? (durationMs / total) * 100 : 100 / services.size,
			}
		})
		.sort((a, b) => b.durationMs - a.durationMs)
}

/**
 * Segmented "where did the time go" bar: one segment per service, sized by its
 * share of wall-clock time, colored by the service's identity color.
 * Decorative reinforcement of the legend chips beside it — each segment still
 * carries a tooltip with the exact figures.
 */
export function ServiceSpectrumBar({
	shares,
	className,
}: {
	shares: ReadonlyArray<ServiceShare>
	className?: string
}) {
	if (shares.length === 0) return null
	return (
		<TooltipProvider>
			<div className={cn("flex h-1.5 w-full gap-px overflow-hidden rounded-full", className)}>
				{shares.map((share) => (
					<Tooltip key={share.serviceName}>
						<TooltipTrigger
							render={<span />}
							className="h-full"
							style={{
								width: `${share.percent}%`,
								minWidth: "4px",
								backgroundColor: getServiceColor(share.serviceName),
							}}
						/>
						<TooltipContent side="top">
							<span className="font-mono tabular-nums">
								{share.serviceName} · {formatDuration(share.durationMs)} ·{" "}
								{formatPercent(share.percent / 100)}
							</span>
						</TooltipContent>
					</Tooltip>
				))}
			</div>
		</TooltipProvider>
	)
}
