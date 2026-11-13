import { Option, String as Str, Array as Arr } from "effect"

// A time chart's x scale, written on its plot anchor so DOM-side code (the linked zoom) can turn a
// pixel into a time without a round trip through the Model.

export const PLOT_TIME_AXIS_ATTRIBUTE = "data-chart-time-axis"

/** The scale's domain in epoch ms and where its two ends sit, in px from the plot's left edge. */
export interface PlotTimeAxis {
	readonly domainStartMs: number
	readonly domainEndMs: number
	readonly startPx: number
	readonly endPx: number
}

export const encodePlotTimeAxis = (axis: PlotTimeAxis): string =>
	Arr.join(Arr.map([axis.domainStartMs, axis.domainEndMs, axis.startPx, axis.endPx], String), ",")

/** `None` for a missing or unreadable attribute, and for a scale with no span to map. */
export const decodePlotTimeAxis = (value: string | null): Option.Option<PlotTimeAxis> => {
	if (value === null) return Option.none()
	const [domainStartMs, domainEndMs, startPx, endPx] = Arr.map(Str.split(",")(value), Number)
	return domainStartMs === undefined ||
		domainEndMs === undefined ||
		startPx === undefined ||
		endPx === undefined ||
		!Arr.every([domainStartMs, domainEndMs, startPx, endPx], Number.isFinite) ||
		domainEndMs <= domainStartMs ||
		endPx === startPx
		? Option.none()
		: Option.some({ domainStartMs, domainEndMs, startPx, endPx })
}

/** The time under `x` (px from the plot's left edge), held inside the domain. */
export const timeAtPlotX = (axis: PlotTimeAxis, x: number): number => {
	const span = axis.domainEndMs - axis.domainStartMs
	const ms = axis.domainStartMs + ((x - axis.startPx) / (axis.endPx - axis.startPx)) * span
	return Math.min(axis.domainEndMs, Math.max(axis.domainStartMs, ms))
}
