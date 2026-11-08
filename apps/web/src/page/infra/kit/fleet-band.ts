import type { Tone } from "@maple/ui/lib/tone"
import { formatNumber, pluralize } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { segmentedBar } from "@maple/views/ui/meter"
import { skeleton, skeletonMeter } from "@maple/views/ui/skeleton"
import { statFigure } from "@maple/views/ui/stat-figure"
import { statRailItem } from "../../kit/stat-rail"
import { typography } from "@maple/views/ui/typography"
import { borderedBoxClass } from "@maple/views/ui/bordered-box"
import { Array as Arr, String as Str } from "effect"
import { vstack } from "@maple/views/ui/stack"

// `FleetBand` and `FleetBandLoading`.

/** A band standing alone on a page body rather than flush under a shell's header. */
export const FLEET_BAND_BOXED = borderedBoxClass({ overflow: "hidden" })

export type FleetBandSegment = Readonly<{ key: string; count: number; className: string }>

export type FleetBandCell<S extends string> = Readonly<{
	scope: S
	label: string
	hint: string
	value: number
	tone: Tone
}>

export type FleetBandOptions<S extends string, M> = Readonly<{
	total: number
	noun: string
	caption: string
	segments: ReadonlyArray<FleetBandSegment>
	cells: ReadonlyArray<FleetBandCell<S>>
	activeScope: S | undefined
	/** The press: the scope, or `undefined` to leave an active one. */
	onScopeChange: (scope: S | undefined) => M
	isWaiting?: boolean
	className?: string
}>

const capitalize = (text: string): string => Str.toUpperCase(Str.slice(0, 1)(text)) + Str.slice(1)(text)

const BAND = "flex flex-col border-b bg-background md:flex-row md:items-stretch"

export const fleetBand = <S extends string, M>(h: HtmlBuilder<M>, options: FleetBandOptions<S, M>): Html => {
	const isWaiting = options.isWaiting === true
	const drawn = Arr.filter(options.segments, (segment) => segment.count > 0)
	return h.div(
		[
			h.Class(cn(BAND, refreshingClass(isWaiting), options.className)),
			...(isWaiting ? [h.AriaBusy(true)] : []),
		],
		[
			vstack(h, { gap: "2", justify: "center", className: "w-full px-4 py-3 md:w-72 md:shrink-0" }, [
				// The same anatomy as the cells beside it: label, value, then the bar and its caption.
				typography(h, { size: "2xs", tone: "muted", weight: "medium", truncate: true }, [
					capitalize(pluralize(2, options.noun)),
					" in scope",
				]),
				statFigure(h, { value: formatNumber(options.total), size: "sm", className: "-mt-1" }),
				options.total > 0
					? segmentedBar(h, {
							className: "w-full gap-px bg-transparent",
							total: options.total,
							minVisible: 2,
							label: Arr.join(
								Arr.map(options.segments, (segment) => `${segment.count} ${segment.key}`),
								", ",
							),
							segments: Arr.map(drawn, (segment) => ({
								key: segment.key,
								value: segment.count,
								className: segment.className,
							})),
						})
					: h.div([h.Class("h-1.5 w-full rounded-full bg-muted")]),
				typography(h, { size: "3xs", tone: "muted" }, [options.caption]),
			]),
			...Arr.map(options.cells, (cell) => {
				const isActive = options.activeScope === cell.scope
				return statRailItem(h, {
					size: "sm",
					eyebrow: cell.label,
					value: String(cell.value),
					subline: cell.hint,
					tone: cell.tone,
					valueClassName: cell.value === 0 ? "text-muted-foreground" : undefined,
					onSelect: options.onScopeChange(isActive ? undefined : cell.scope),
					isSelected: isActive,
					isDisabled: cell.value === 0 && !isActive,
					className: "flex flex-1 flex-col justify-center border-l",
				})
			}),
		],
	)
}

export const fleetBandLoading = <M>(h: HtmlBuilder<M>, cells: number, className?: string): Html =>
	h.div(
		[h.Class(cn(BAND, className))],
		[
			vstack(h, { gap: "2", justify: "center", className: "w-full px-4 py-3 md:w-72 md:shrink-0" }, [
				skeleton(h, "h-3 w-24"),
				skeleton(h, "h-5 w-10"),
				skeletonMeter(h),
				skeleton(h, "h-2.5 w-40"),
			]),
			...Array.from({ length: cells }, () =>
				vstack(h, { gap: "1.5", justify: "center", grow: true, className: "border-l px-4 py-3" }, [
					skeleton(h, "h-3 w-20"),
					skeleton(h, "h-5 w-10"),
					skeleton(h, "h-2.5 w-32"),
				]),
			),
		],
	)
