import { formatPercent } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import {
	deltaBadStyles,
	deltaEmptyStyles,
	deltaGoodStyles,
	deltaMutedStyles,
	deltaStyles,
	deltaSuffixStyles,
} from "@maple/ui/styles/ui/delta"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/delta.tsx: change against a previous window.

/** Relative change from `previous` to `current`, or null when there is no baseline. */
export const relativeChange = (current: number, previous: number): number | null =>
	!Number.isFinite(previous) || previous <= 0 || !Number.isFinite(current)
		? null
		: (current - previous) / previous

export interface DeltaOptions {
	readonly ratio?: number | null
	readonly current?: number
	readonly previous?: number
	/** For metrics where down is good (error rate, latency). */
	readonly invert?: boolean
	readonly suffix?: Html | string
	readonly flatThreshold?: number
	readonly format?: (magnitude: number) => string
	readonly muteWorse?: boolean
	readonly className?: string
}

export const delta = <M>(h: HtmlBuilder<M>, options: DeltaOptions): Html => {
	const change =
		options.ratio !== undefined
			? options.ratio
			: options.current !== undefined && options.previous !== undefined
				? relativeChange(options.current, options.previous)
				: null
	if (change === null || !Number.isFinite(change)) {
		return h.span([h.Class(cn(deltaEmptyStyles, options.className))], ["–"])
	}
	const flat = Math.abs(change) < (options.flatThreshold ?? 0.001)
	const rose = change > 0
	const good = (options.invert ?? false) ? !rose : rose
	const magnitude = (options.format ?? formatPercent)(Math.abs(change))
	const tone =
		flat || (!good && options.muteWorse === true)
			? deltaMutedStyles
			: good
				? deltaGoodStyles
				: deltaBadStyles
	return h.span(
		[
			h.Class(cn(deltaStyles, tone, options.className)),
			h.Title(`${flat ? "Flat" : rose ? "Up" : "Down"} ${magnitude} vs the previous period`),
			h.DataAttribute("slot", "delta"),
		],
		[
			h.span([h.AriaHidden(true)], [flat ? "→" : rose ? "↑" : "↓"]),
			magnitude,
			...(options.suffix ? [h.span([h.Class(deltaSuffixStyles)], [options.suffix])] : []),
		],
	)
}
