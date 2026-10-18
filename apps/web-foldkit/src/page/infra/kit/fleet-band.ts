import { VALUE_TONE } from "@maple/web/components/infra/severity-tokens"
import { formatNumber, pluralize } from "@maple/ui/lib/format"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import type { Html, HtmlBuilder } from "foldkit/html"
import { segmentedBar } from "../../../ui/meter"
import { skeleton } from "../../../ui/skeleton"
import { statFigure } from "../../../ui/stat-figure"

// `FleetBand` / `FleetBandLoading` (primitives/fleet-band.tsx) and the selectable small
// `StatRailItem` its cells are (components/common/stat-rail.tsx).

export const FLEET_BAND_BOXED = "overflow-hidden rounded-md border"

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
	/** The scope a press sets: `undefined` when pressing the active cell. */
	onScopeChange: (scope: S | undefined) => M
	isWaiting?: boolean
	className?: string
}>

const BAND_CLASS = "flex flex-col border-b bg-background md:flex-row md:items-stretch"
const LEAD_CLASS = "flex w-full flex-col justify-center gap-2 px-4 py-3 md:w-72 md:shrink-0"

/** `StatRailItem size="sm"` with `onSelect`: a zero cell is drawn but disabled unless active. */
const scopeCell = <S extends string, M>(
	h: HtmlBuilder<M>,
	cell: FleetBandCell<S>,
	isActive: boolean,
	onSelect: M,
): Html => {
	const isIdle = cell.value === 0 && !isActive
	return h.button(
		[
			h.Key(cell.scope),
			h.Type("button"),
			...(isIdle ? [h.Disabled(true)] : []),
			h.AriaPressed(String(isActive)),
			h.OnClick(onSelect),
			h.Class(
				cn(
					cn(
						"relative animate-in fade-in slide-in-from-bottom-1 duration-500",
						"px-4 py-3",
						"flex flex-1 flex-col justify-center border-l",
					),
					"w-full text-left",
					rowSelectedClass(isActive),
					isIdle ? "cursor-default" : "cursor-pointer hover:bg-muted/25",
					"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
				),
			),
		],
		[
			h.div(
				[h.Class("flex items-baseline justify-between gap-3")],
				[
					h.span(
						[
							h.Class(
								cn(
									"truncate text-2xs font-medium transition-colors",
									isActive ? "text-primary" : "text-muted-foreground",
								),
							),
						],
						[cell.label],
					),
				],
			),
			h.div(
				[h.Class(cn("flex items-end justify-between gap-3", "mt-1.5"))],
				[
					statFigure(h, {
						value: String(cell.value),
						unit: cell.hint,
						size: "sm",
						className: "shrink-0",
						valueClassName: cn(
							VALUE_TONE[cell.tone],
							cell.value === 0 ? "text-muted-foreground" : undefined,
						),
					}),
				],
			),
		],
	)
}

const bandLead = <M>(
	h: HtmlBuilder<M>,
	options: Pick<FleetBandOptions<string, M>, "total" | "noun" | "caption" | "segments">,
): Html =>
	h.div(
		[h.Class(LEAD_CLASS)],
		[
			h.span(
				[h.Class("flex items-baseline gap-1.5")],
				[
					h.span(
						[h.Class("font-mono text-base font-semibold tabular-nums")],
						[formatNumber(options.total)],
					),
					h.span(
						[h.Class("text-2xs text-muted-foreground")],
						[pluralize(options.total, options.noun), " in scope"],
					),
				],
			),
			options.total > 0
				? segmentedBar(h, {
						className: "w-full gap-px bg-transparent",
						total: options.total,
						minVisible: 2,
						label: options.segments
							.map((segment) => `${segment.count} ${segment.key}`)
							.join(", "),
						segments: options.segments
							.filter((segment) => segment.count > 0)
							.map((segment) => ({
								key: segment.key,
								value: segment.count,
								className: segment.className,
							})),
					})
				: h.div([h.Class("h-1.5 w-full rounded-full bg-muted")]),
			h.span([h.Class("text-3xs text-muted-foreground")], [options.caption]),
		],
	)

export const fleetBand = <S extends string, M>(h: HtmlBuilder<M>, options: FleetBandOptions<S, M>): Html => {
	const isWaiting = options.isWaiting === true
	return h.div(
		[
			h.Class(cn(BAND_CLASS, refreshingClass(isWaiting), options.className)),
			...(isWaiting ? [h.AriaBusy(true)] : []),
		],
		[
			bandLead(h, options),
			...options.cells.map((cell) => {
				const isActive = options.activeScope === cell.scope
				return scopeCell(h, cell, isActive, options.onScopeChange(isActive ? undefined : cell.scope))
			}),
		],
	)
}

export const fleetBandLoading = <M>(h: HtmlBuilder<M>, cells: number, className?: string): Html =>
	h.div(
		[h.Class(cn(BAND_CLASS, className))],
		[
			h.div(
				[h.Class(LEAD_CLASS)],
				[
					skeleton(h, "h-4 w-28"),
					skeleton(h, "h-1.5 w-full rounded-full"),
					skeleton(h, "h-2.5 w-40"),
				],
			),
			...Array.from({ length: cells }, () =>
				h.div(
					[h.Class("flex flex-1 flex-col justify-center gap-1.5 border-l px-4 py-3")],
					[skeleton(h, "h-3 w-20"), skeleton(h, "h-5 w-10")],
				),
			),
		],
	)
